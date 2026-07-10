import type { ParsedInbound, EntryPoint } from '../types.js';
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
import { sendFreeformToLead } from './outbound.js';
import { generateAiReply, ensureOptOut } from '../ai/reply.js';
import { isWindowOpen } from '../lib/window.js';

const OPT_OUT_CONFIRMATION =
  "You're unsubscribed and won't get further messages from us. " +
  'Thanks — reply anytime if you change your mind.';

function fixedWelcome(name: string | null): string {
  const greeting = name ? `Hi ${name.split(' ')[0]}! ` : 'Hi there! ';
  return ensureOptOut(
    `${greeting}Thanks for reaching out 🙌 Tell me what you're looking for and I'll help you sort it out right away.`,
  );
}

export interface InboundOutcome {
  duplicate: boolean;
  leadId?: string;
  isNewLead?: boolean;
  optedOut?: boolean;
  replied?: boolean;
  scheduled?: number;
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

  // Step 4 — upsert lead (window logic lives in the query).
  const { lead, isNew } = await upsertLeadOnInbound({
    waId: parsed.waId,
    name: parsed.profileName,
    entryPoint,
    source: parsed.source,
    at,
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
    return { duplicate: false, leadId: lead.id, isNewLead: isNew };
  }

  // Step 7 — instant auto-reply (free-form, inside the window) + ENGAGED.
  await ensureEngaged(lead.id);
  let replied = false;
  if (windowOpen) {
    const aiReply = config.ai.enabled ? await generateAiReply(parsed.body, lead.name) : null;
    const body = aiReply ?? fixedWelcome(lead.name);
    replied = await safeSend(() => sendFreeformToLead(lead.id, lead.wa_id, body));
  } else {
    log.warn('window closed on inbound — skipping instant reply', { leadId: lead.id });
  }

  // Step 8 — schedule the 7-day sequence, only on the first inbound for a lead.
  let scheduled = 0;
  if (isNew) {
    const windowExpiry = lead.window_expires_at ? new Date(lead.window_expires_at) : null;
    scheduled = await scheduleSequence(lead.id, at, windowExpiry);
    log.info('scheduled sequence', { leadId: lead.id, scheduled });
  }

  return {
    duplicate: false,
    leadId: lead.id,
    isNewLead: isNew,
    optedOut: false,
    replied,
    scheduled,
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
