import type { ParsedInbound, EntryPoint, Offer } from '../types.js';
import { log } from '../logger.js';
import { config } from '../config.js';
import { messageExists, logMessage } from './messages.js';
import {
  upsertLeadOnInbound,
  ensureEngaged,
  setStatus,
} from './leads.js';
import { scheduleSequence, cancelPendingFollowups } from './followups.js';
import { isOptOut } from './optout.js';
import { isPaymentClaim } from './paymentIntent.js';
import { claimPayment } from './payments.js';
import { matchOfferByKeyword, getDefaultOffer, offerSequence, canonicalSequence, stepBubbles } from './offers.js';
import { sendFreeformToLead, sendBubblesToLead } from './outbound.js';
import { generateAiReply, ensureOptOut } from '../ai/reply.js';
import { renderMessage } from '../lib/render.js';
import { isWindowOpen } from '../lib/window.js';
import type { Bubble } from '../types.js';

const OPT_OUT_CONFIRMATION =
  "You're unsubscribed and won't get further messages from us. " +
  'Thanks — reply anytime if you change your mind.';

/**
 * Welcome bubbles: the offer's step-0 bubbles (rendered), else a generic
 * fallback. The opt-out line is appended once, to the last text bubble.
 */
function welcomeBubbles(offer: Offer | null, name: string | null): Bubble[] {
  const ctx = { name, offerName: offer?.name, priceKobo: offer?.price_kobo };
  const step0 = offer ? offerSequence(offer).find((s) => s.step === 0) : undefined;
  let bubbles: Bubble[] = (step0 ? stepBubbles(step0) : []).map((b) => ({
    body: b.body ? renderMessage(b.body, ctx) : null,
    imageUrl: b.imageUrl ?? null,
  }));
  if (bubbles.length === 0) {
    const greeting = name ? `Hi ${name.split(' ')[0]}! ` : 'Hi there! ';
    bubbles = [{
      body: `${greeting}Thanks for reaching out 🙌 Tell me what you're looking for and I'll help you sort it out right away.`,
    }];
  }
  const lastText = [...bubbles].reverse().find((b) => b.body);
  if (lastText?.body) lastText.body = ensureOptOut(lastText.body);
  return bubbles;
}

export interface InboundOutcome {
  duplicate: boolean;
  leadId?: string;
  isNewLead?: boolean;
  optedOut?: boolean;
  replied?: boolean;
  scheduled?: number;
  offerId?: string | null;
  offerUnmatched?: boolean;
  paymentClaimed?: boolean;
}

/**
 * End-to-end processing of one inbound message (§6.1 steps 2–8). Designed to be
 * called *after* the route has already responded 200 to Meta, so sends and DB
 * writes happen off the request's critical path.
 *
 * Idempotent on `wa_message_id`: a re-delivered webhook is detected either by
 * the up-front existence check or by the ON CONFLICT on the message insert.
 */
export async function processInbound(parsed: ParsedInbound): Promise<InboundOutcome> {
  // Step 2 — dedupe (fast path).
  if (await messageExists(parsed.waMessageId)) {
    log.debug('duplicate inbound ignored', { waMessageId: parsed.waMessageId });
    return { duplicate: true };
  }

  const entryPoint: EntryPoint = parsed.isAd ? 'ad' : 'organic';
  const at = parsed.timestamp ? new Date(parsed.timestamp * 1000) : new Date();

  // Feature A — resolve the offer from the first message's keyword. Unmatched
  // leads fall under the default offer and are flagged for manual assignment.
  const matched = await matchOfferByKeyword(parsed.body);
  const defaultOffer = matched ? null : await getDefaultOffer();
  const resolvedOffer = matched ?? defaultOffer;
  const offerUnmatched = !matched;

  // Step 4 — upsert lead (window logic lives in the query).
  const { lead, isNew } = await upsertLeadOnInbound({
    waId: parsed.waId,
    name: parsed.profileName,
    entryPoint,
    source: parsed.source,
    at,
    offerId: resolvedOffer?.id ?? null,
    offerUnmatched,
  });

  // Step 5 — log inbound message. ON CONFLICT means a racing duplicate returns
  // null; bail so we never double-reply.
  const logged = await logMessage({
    leadId: lead.id,
    direction: 'IN',
    body: parsed.body,
    type: parsed.type,
    waMessageId: parsed.waMessageId,
  });
  if (!logged) {
    log.debug('inbound lost dedupe race, ignoring', { waMessageId: parsed.waMessageId });
    return { duplicate: true, leadId: lead.id };
  }

  const windowOpen = isWindowOpen(lead.window_expires_at);

  // Step 6 — opt-out. Terminal: flag, cancel schedule, one confirmation, exit.
  if (isOptOut(parsed.body)) {
    await setStatus(lead.id, 'OPTED_OUT');
    const cancelled = await cancelPendingFollowups(lead.id);
    if (windowOpen) {
      await safeSend(() => sendFreeformToLead(lead.id, lead.wa_id, OPT_OUT_CONFIRMATION));
    }
    log.info('lead opted out', { leadId: lead.id, cancelled });
    return { duplicate: false, leadId: lead.id, isNewLead: isNew, optedOut: true };
  }

  // Never re-engage or message a terminal lead (§5). A PAID lead that messages
  // in still gets logged above, but no automated outreach.
  if (lead.status === 'PAID' || lead.status === 'OPTED_OUT') {
    log.debug('inbound from terminal lead, logged only', { leadId: lead.id, status: lead.status });
    return { duplicate: false, leadId: lead.id, isNewLead: isNew, offerId: lead.offer_id };
  }

  // Feature B — payment claim. If the buyer says they paid, move to review and
  // pause follow-ups; never auto-reply/schedule. Approval is always manual.
  if (isPaymentClaim(parsed.body)) {
    const { claimed } = await claimPayment(lead, windowOpen);
    return {
      duplicate: false,
      leadId: lead.id,
      isNewLead: isNew,
      offerId: lead.offer_id,
      offerUnmatched: lead.offer_unmatched,
      paymentClaimed: claimed,
    };
  }

  // A lead already awaiting payment review shouldn't get fresh outreach.
  if (lead.status === 'PAYMENT_CLAIMED') {
    log.debug('inbound from lead under payment review, logged only', { leadId: lead.id });
    return { duplicate: false, leadId: lead.id, isNewLead: isNew, offerId: lead.offer_id };
  }

  // Step 7 — instant auto-reply (free-form, inside the window) + ENGAGED.
  await ensureEngaged(lead.id);
  let replied = false;
  if (windowOpen) {
    const aiReply = config.ai.enabled ? await generateAiReply(parsed.body, lead.name) : null;
    const bubbles: Bubble[] = aiReply ? [{ body: aiReply }] : welcomeBubbles(resolvedOffer, lead.name);
    replied = await safeSend(async () => { await sendBubblesToLead(lead.id, lead.wa_id, bubbles); });
  } else {
    log.warn('window closed on inbound — skipping instant reply', { leadId: lead.id });
  }

  // Step 8 — schedule the follow-up sequence (the lead's offer sequence), only
  // on the first inbound for a lead.
  let scheduled = 0;
  if (isNew) {
    const windowExpiry = lead.window_expires_at ? new Date(lead.window_expires_at) : null;
    const steps = resolvedOffer ? offerSequence(resolvedOffer) : canonicalSequence();
    scheduled = await scheduleSequence(lead.id, at, windowExpiry, steps, {
      name: lead.name,
      offerName: resolvedOffer?.name,
      priceKobo: resolvedOffer?.price_kobo,
    });
    log.info('scheduled sequence', { leadId: lead.id, scheduled, offerId: lead.offer_id });
  }

  return {
    duplicate: false,
    leadId: lead.id,
    isNewLead: isNew,
    optedOut: false,
    replied,
    scheduled,
    offerId: lead.offer_id,
    offerUnmatched: lead.offer_unmatched,
  };
}

/** Run a send, swallowing errors so one failed send never aborts processing. */
async function safeSend(fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    log.error('outbound send failed', { error: (err as Error).message });
    return false;
  }
}
