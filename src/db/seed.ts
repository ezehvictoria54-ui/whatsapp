import { pool, query } from './pool.js';
import { log } from '../logger.js';
import type { Channel, EntryPoint, FollowupStatus, LeadStatus, OfferSequenceStep } from '../types.js';
import { ensureDefaultOffer, canonicalSequence } from '../services/offers.js';

/**
 * Seed realistic fake data so the dashboard shows meaningful content:
 *  - a couple of keyworded offers (plus the default offer),
 *  - ~12 leads across every status including two "Payment Claimed" leads,
 *  - a short thread + follow-ups per lead, and payments for PAID leads.
 *
 * Idempotent: it deletes any previously-seeded leads (identified by their
 * `wa_id`, which all share the reserved `234800000xx` prefix) before inserting,
 * and upserts the seed offers by keyword, so `npm run seed` can be run
 * repeatedly without piling up duplicates. It only ever touches its own rows.
 */

type OfferKey = 'default' | 'glow' | 'fit';

/** Build a per-offer sequence from the canonical one with a custom welcome/CTA. */
function offerSeq(welcome: string, cta: string): OfferSequenceStep[] {
  const seq = canonicalSequence();
  const s0 = seq.find((s) => s.step === 0);
  const s2 = seq.find((s) => s.step === 2);
  if (s0) s0.freeformBody = welcome;
  if (s2) s2.freeformBody = cta;
  return seq;
}

interface SeedOffer {
  key: Exclude<OfferKey, 'default'>;
  name: string;
  keyword: string;
  priceKobo: number;
  sequence: OfferSequenceStep[];
}

const SEED_OFFERS: SeedOffer[] = [
  {
    key: 'glow',
    name: 'Glow Skincare Set',
    keyword: 'glow',
    priceKobo: 1_250_000, // ₦12,500
    sequence: offerSeq(
      'Hi {name}! 🌟 Thanks for your interest in the {offer}. It\'s {price} for the full routine. Want me to set up your order? Reply STOP to opt out anytime.',
      'Here\'s a before/after from a {offer} customer 👇 Ready to glow? I can set up your order in a minute. Reply STOP to opt out.',
    ),
  },
  {
    key: 'fit',
    name: 'FitPro 8-Week Plan',
    keyword: 'fit',
    priceKobo: 1_800_000, // ₦18,000
    sequence: offerSeq(
      'Hi {name}! 💪 Thanks for asking about the {offer}. It\'s {price} and includes workouts + a meal guide. Want in? Reply STOP to opt out anytime.',
      'A recent {offer} member lost 6kg in 8 weeks 🔥 Want me to lock in your spot at {price}? Reply STOP to opt out.',
    ),
  },
];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const ahead = (ms: number) => new Date(now + ms).toISOString();

interface SeedMessage {
  direction: 'IN' | 'OUT';
  body: string;
  type?: string;
  atMs: number; // how long ago
}
interface SeedFollowup {
  step: number;
  channel: Channel;
  templateName?: string | null;
  status: FollowupStatus;
  sendAtMs: number; // negative = future (due later), positive = in the past
}
interface SeedLead {
  wa_id: string;
  name: string;
  status: LeadStatus;
  entry_point: EntryPoint;
  source: string | null;
  sequence_step: number;
  createdAgoMs: number;
  windowExpiresAtMs: number; // signed offset from now; negative = future
  offerKey?: OfferKey; // defaults to 'default' (organic, unmatched)
  claimedAgoMs?: number; // set for PAYMENT_CLAIMED leads
  messages: SeedMessage[];
  followups: SeedFollowup[];
  payment?: { reference: string; amountKobo: number };
}

const OPT_OUT_LINE = 'Reply STOP to opt out anytime.';

const LEADS: SeedLead[] = [
  // ── NEW (2) — just arrived, greeted, sequence pending ──────────────────────
  {
    wa_id: '2348000000001', name: 'Chidinma Okafor', status: 'NEW', entry_point: 'ad', offerKey: 'glow',
    source: 'AD_LAGOS_SKINCARE', sequence_step: 0, createdAgoMs: 20 * 60 * 1000,
    windowExpiresAtMs: -(72 * HOUR - 20 * 60 * 1000),
    messages: [
      { direction: 'IN', body: 'Hi, I saw your ad on Instagram. How much is the starter set?', atMs: 20 * 60 * 1000 },
      { direction: 'OUT', body: `Hi Chidinma! Thanks for reaching out 🙌 The starter set is ₦12,500. Want me to set up your order? ${OPT_OUT_LINE}`, atMs: 19 * 60 * 1000 },
    ],
    followups: [
      { step: 1, channel: 'FREEFORM', status: 'PENDING', sendAtMs: -(3 * HOUR) },
      { step: 2, channel: 'FREEFORM', status: 'PENDING', sendAtMs: -(24 * HOUR) },
    ],
  },
  {
    wa_id: '2348000000002', name: 'Emeka Nwosu', status: 'NEW', entry_point: 'organic',
    source: null, sequence_step: 0, createdAgoMs: 90 * 60 * 1000,
    windowExpiresAtMs: -(24 * HOUR - 90 * 60 * 1000),
    messages: [
      { direction: 'IN', body: 'Good afternoon, do you deliver to Enugu?', atMs: 90 * 60 * 1000 },
      { direction: 'OUT', body: `Hi Emeka! Yes, we deliver nationwide including Enugu 🚚 What would you like to order? ${OPT_OUT_LINE}`, atMs: 88 * 60 * 1000 },
    ],
    followups: [
      { step: 1, channel: 'FREEFORM', status: 'PENDING', sendAtMs: -(3 * HOUR) },
      { step: 2, channel: 'FREEFORM', status: 'PENDING', sendAtMs: -(24 * HOUR) },
    ],
  },

  // ── ENGAGED (3) — active conversations, some follow-ups already sent ────────
  {
    wa_id: '2348000000003', name: 'Aisha Bello', status: 'ENGAGED', entry_point: 'ad', offerKey: 'fit',
    source: 'AD_ABUJA_FITNESS', sequence_step: 2, createdAgoMs: 2 * DAY,
    windowExpiresAtMs: -(72 * HOUR - 2 * DAY),
    messages: [
      { direction: 'IN', body: 'I clicked from your fitness ad. Does the plan include meal guides?', atMs: 2 * DAY },
      { direction: 'OUT', body: `Hi Aisha! Yes — the plan includes a 4-week meal guide and workouts. ${OPT_OUT_LINE}`, atMs: 2 * DAY - 2 * 60 * 1000 },
      { direction: 'OUT', body: 'Quick note: most customers ask about pricing and delivery — happy to answer anything!', atMs: 2 * DAY - 3 * HOUR },
      { direction: 'IN', body: 'Sounds good. Let me think about it and get back to you.', atMs: 1 * DAY },
      { direction: 'OUT', body: "Here's a recent result from a customer just like you 👇 Ready when you are!", atMs: 1 * DAY - 30 * 60 * 1000 },
    ],
    followups: [
      { step: 1, channel: 'FREEFORM', status: 'SENT', sendAtMs: 2 * DAY - 3 * HOUR },
      { step: 2, channel: 'FREEFORM', status: 'SENT', sendAtMs: 1 * DAY - 30 * 60 * 1000 },
      { step: 3, channel: 'FREEFORM', status: 'PENDING', sendAtMs: -(6 * HOUR) },
    ],
  },
  {
    wa_id: '2348000000004', name: 'Tunde Adeyemi', status: 'ENGAGED', entry_point: 'ad', offerKey: 'glow',
    source: 'AD_LAGOS_SKINCARE', sequence_step: 1, createdAgoMs: 5 * HOUR,
    windowExpiresAtMs: -(72 * HOUR - 5 * HOUR),
    messages: [
      { direction: 'IN', body: 'Do you have the anti-acne bundle in stock?', atMs: 5 * HOUR },
      { direction: 'OUT', body: `Hi Tunde! Yes, the anti-acne bundle is in stock at ₦9,000. ${OPT_OUT_LINE}`, atMs: 5 * HOUR - 60 * 1000 },
      { direction: 'IN', body: 'Great, what are the payment options?', atMs: 4 * HOUR },
      { direction: 'OUT', body: 'You can pay by bank transfer, USSD or card — I can send you a secure account number.', atMs: 4 * HOUR - 90 * 1000 },
    ],
    followups: [
      { step: 1, channel: 'FREEFORM', status: 'SENT', sendAtMs: 2 * HOUR },
      { step: 2, channel: 'FREEFORM', status: 'PENDING', sendAtMs: -(19 * HOUR) },
    ],
  },
  {
    wa_id: '2348000000005', name: 'Ngozi Eze', status: 'ENGAGED', entry_point: 'organic',
    source: null, sequence_step: 1, createdAgoMs: 10 * HOUR,
    windowExpiresAtMs: -(24 * HOUR - 10 * HOUR),
    messages: [
      { direction: 'IN', body: 'A friend referred me. Can I get the family pack?', atMs: 10 * HOUR },
      { direction: 'OUT', body: `Welcome Ngozi! 🙌 The family pack is ₦25,000 and feeds 6. ${OPT_OUT_LINE}`, atMs: 10 * HOUR - 60 * 1000 },
      { direction: 'IN', body: 'Perfect, I will order this weekend.', atMs: 8 * HOUR },
    ],
    followups: [
      { step: 1, channel: 'FREEFORM', status: 'SENT', sendAtMs: 7 * HOUR },
      { step: 2, channel: 'FREEFORM', status: 'PENDING', sendAtMs: -(14 * HOUR) },
    ],
  },

  // ── PAID (3) — converted; follow-ups cancelled; payment recorded ────────────
  {
    wa_id: '2348000000006', name: 'Blessing Okon', status: 'PAID', entry_point: 'ad', offerKey: 'fit',
    source: 'AD_ABUJA_FITNESS', sequence_step: 2, createdAgoMs: 3 * DAY,
    windowExpiresAtMs: -(72 * HOUR - 3 * DAY),
    messages: [
      { direction: 'IN', body: 'I want to buy the 8-week plan.', atMs: 3 * DAY },
      { direction: 'OUT', body: `Awesome Blessing! Transfer ₦18,000 to the secure account below and you're in. ${OPT_OUT_LINE}`, atMs: 3 * DAY - 2 * 60 * 1000 },
      { direction: 'IN', body: 'Done, I have sent it.', atMs: 3 * DAY - 15 * 60 * 1000 },
      { direction: 'OUT', body: 'Payment received — thank you! Your order is confirmed. 🎉', atMs: 3 * DAY - 14 * 60 * 1000 },
    ],
    followups: [
      { step: 1, channel: 'FREEFORM', status: 'SENT', sendAtMs: 3 * DAY - 3 * HOUR },
      { step: 2, channel: 'FREEFORM', status: 'CANCELLED', sendAtMs: -(1 * DAY) },
    ],
    payment: { reference: 'seed_ref_blessing_001', amountKobo: 1_800_000 },
  },
  {
    wa_id: '2348000000007', name: 'Ibrahim Musa', status: 'PAID', entry_point: 'ad', offerKey: 'glow',
    source: 'AD_LAGOS_SKINCARE', sequence_step: 3, createdAgoMs: 4 * DAY,
    windowExpiresAtMs: -(72 * HOUR - 4 * DAY),
    messages: [
      { direction: 'IN', body: 'Saw the skincare ad, I want the full routine.', atMs: 4 * DAY },
      { direction: 'OUT', body: `Great choice Ibrahim! The full routine is ₦21,500. ${OPT_OUT_LINE}`, atMs: 4 * DAY - 60 * 1000 },
      { direction: 'OUT', body: 'Sending your secure account details now — it expires in 3 hours.', atMs: 4 * DAY - 2 * HOUR },
      { direction: 'IN', body: 'Paid!', atMs: 4 * DAY - 2 * HOUR - 20 * 60 * 1000 },
      { direction: 'OUT', body: 'Payment received — thank you! Your order is confirmed.', atMs: 4 * DAY - 2 * HOUR - 19 * 60 * 1000 },
    ],
    followups: [
      { step: 1, channel: 'FREEFORM', status: 'SENT', sendAtMs: 4 * DAY - 3 * HOUR },
      { step: 2, channel: 'FREEFORM', status: 'CANCELLED', sendAtMs: -(2 * DAY) },
    ],
    payment: { reference: 'seed_ref_ibrahim_002', amountKobo: 2_150_000 },
  },
  {
    wa_id: '2348000000008', name: 'Funke Adebayo', status: 'PAID', entry_point: 'organic',
    source: null, sequence_step: 1, createdAgoMs: 6 * HOUR,
    windowExpiresAtMs: -(24 * HOUR - 6 * HOUR),
    messages: [
      { direction: 'IN', body: 'Please send account details for the ₦7,500 item.', atMs: 6 * HOUR },
      { direction: 'OUT', body: `Sure Funke! Here are your secure account details. ${OPT_OUT_LINE}`, atMs: 6 * HOUR - 60 * 1000 },
      { direction: 'IN', body: 'Transfer sent.', atMs: 5 * HOUR },
      { direction: 'OUT', body: 'Payment received — thank you! Your order is confirmed.', atMs: 5 * HOUR - 60 * 1000 },
    ],
    followups: [{ step: 1, channel: 'FREEFORM', status: 'CANCELLED', sendAtMs: -(3 * HOUR) }],
    payment: { reference: 'seed_ref_funke_003', amountKobo: 750_000 },
  },

  // ── OPTED_OUT (2) — sent STOP; everything halted ────────────────────────────
  {
    wa_id: '2348000000009', name: 'Samuel Ojo', status: 'OPTED_OUT', entry_point: 'ad', offerKey: 'fit',
    source: 'AD_ABUJA_FITNESS', sequence_step: 1, createdAgoMs: 2 * DAY,
    windowExpiresAtMs: -(72 * HOUR - 2 * DAY),
    messages: [
      { direction: 'IN', body: 'How much is the plan?', atMs: 2 * DAY },
      { direction: 'OUT', body: `Hi Samuel! The plan is ₦15,000. ${OPT_OUT_LINE}`, atMs: 2 * DAY - 60 * 1000 },
      { direction: 'IN', body: 'STOP', atMs: 1 * DAY },
      { direction: 'OUT', body: "You're unsubscribed and won't get further messages from us. Thanks — reply anytime if you change your mind.", atMs: 1 * DAY - 30 * 1000 },
    ],
    followups: [
      { step: 1, channel: 'FREEFORM', status: 'SENT', sendAtMs: 2 * DAY - 3 * HOUR },
      { step: 2, channel: 'FREEFORM', status: 'CANCELLED', sendAtMs: -(1 * DAY) },
    ],
  },
  {
    wa_id: '2348000000010', name: 'Grace Udo', status: 'OPTED_OUT', entry_point: 'organic',
    source: null, sequence_step: 0, createdAgoMs: 3 * DAY,
    windowExpiresAtMs: -(24 * HOUR - 3 * DAY), // window already closed
    messages: [
      { direction: 'IN', body: 'Not interested, please remove me.', atMs: 3 * DAY },
      { direction: 'IN', body: 'UNSUBSCRIBE', atMs: 3 * DAY - 60 * 1000 },
      { direction: 'OUT', body: "You're unsubscribed and won't get further messages from us.", atMs: 3 * DAY - 90 * 1000 },
    ],
    followups: [{ step: 1, channel: 'FREEFORM', status: 'CANCELLED', sendAtMs: -(3 * DAY - 3 * HOUR) }],
  },

  // ── PAYMENT_CLAIMED (2) — buyer says they paid; awaiting manual approval ─────
  {
    wa_id: '2348000000011', name: 'Amara Nnamdi', status: 'PAYMENT_CLAIMED', entry_point: 'ad',
    offerKey: 'glow', source: 'AD_LAGOS_SKINCARE', sequence_step: 2, createdAgoMs: 6 * HOUR,
    windowExpiresAtMs: -(72 * HOUR - 6 * HOUR), claimedAgoMs: 12 * 60 * 1000,
    messages: [
      { direction: 'IN', body: 'glow — I want the skincare set', atMs: 6 * HOUR },
      { direction: 'OUT', body: `Hi Amara! 🌟 The Glow Skincare Set is ₦12,500. Here are your secure account details. ${OPT_OUT_LINE}`, atMs: 6 * HOUR - 60 * 1000 },
      { direction: 'IN', body: "I've paid", atMs: 12 * 60 * 1000 },
      { direction: 'OUT', body: "Thank you! 🙏 We've noted your payment and it's being confirmed. You'll get a confirmation here shortly.", atMs: 12 * 60 * 1000 - 20 * 1000 },
    ],
    // Follow-ups stay PENDING (paused) so they resume if the claim is rejected.
    followups: [
      { step: 1, channel: 'FREEFORM', status: 'SENT', sendAtMs: 3 * HOUR },
      { step: 2, channel: 'FREEFORM', status: 'PENDING', sendAtMs: -(6 * HOUR) },
    ],
  },
  {
    wa_id: '2348000000012', name: 'Kunle Balogun', status: 'PAYMENT_CLAIMED', entry_point: 'ad',
    offerKey: 'fit', source: 'AD_ABUJA_FITNESS', sequence_step: 1, createdAgoMs: 26 * HOUR,
    windowExpiresAtMs: -(72 * HOUR - 26 * HOUR), claimedAgoMs: 70 * 60 * 1000,
    messages: [
      { direction: 'IN', body: 'start fit', atMs: 26 * HOUR },
      { direction: 'OUT', body: `Hi Kunle! 💪 The FitPro 8-Week Plan is ₦18,000. Want in? ${OPT_OUT_LINE}`, atMs: 26 * HOUR - 60 * 1000 },
      { direction: 'IN', body: 'done, transferred', atMs: 70 * 60 * 1000 },
      { direction: 'OUT', body: "Thank you! 🙏 We've noted your payment and it's being confirmed.", atMs: 70 * 60 * 1000 - 20 * 1000 },
    ],
    followups: [
      { step: 1, channel: 'FREEFORM', status: 'SENT', sendAtMs: 23 * HOUR },
      { step: 2, channel: 'FREEFORM', status: 'PENDING', sendAtMs: -(2 * HOUR) },
    ],
  },
];

export async function seedDatabase(): Promise<void> {
  const waIds = LEADS.map((l) => l.wa_id);

  // Idempotency: remove any prior seed rows (children cascade on lead delete).
  const del = await query('DELETE FROM leads WHERE wa_id = ANY($1::text[])', [waIds]);
  if ((del.rowCount ?? 0) > 0) log.info('cleared previous seed leads', { count: del.rowCount });

  // Offers: ensure the default exists, then upsert the keyworded seed offers.
  const defaultOffer = await ensureDefaultOffer();
  const offerIdByKey: Record<OfferKey, string> = { default: defaultOffer.id, glow: '', fit: '' };
  for (const o of SEED_OFFERS) {
    const res = await query<{ id: string }>(
      `INSERT INTO offers (name, price_kobo, keyword, sequence, active)
       VALUES ($1,$2,$3,$4::jsonb,true)
       ON CONFLICT (keyword) WHERE keyword IS NOT NULL DO UPDATE SET
         name = EXCLUDED.name, price_kobo = EXCLUDED.price_kobo,
         sequence = EXCLUDED.sequence, updated_at = now()
       RETURNING id`,
      [o.name, o.priceKobo, o.keyword, JSON.stringify(o.sequence)],
    );
    offerIdByKey[o.key] = res.rows[0]!.id;
  }

  let msgCount = 0;
  let fuCount = 0;
  let payCount = 0;

  for (const l of LEADS) {
    const offerKey: OfferKey = l.offerKey ?? 'default';
    const offerId = offerIdByKey[offerKey];
    const unmatched = offerKey === 'default';
    const leadRes = await query<{ id: string }>(
      `INSERT INTO leads (wa_id, name, source, status, entry_point, sequence_step,
                          window_expires_at, offer_id, offer_unmatched, payment_claimed_at,
                          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       RETURNING id`,
      [
        l.wa_id, l.name, l.source, l.status, l.entry_point, l.sequence_step,
        l.windowExpiresAtMs >= 0 ? ago(l.windowExpiresAtMs) : ahead(-l.windowExpiresAtMs),
        offerId, unmatched,
        l.claimedAgoMs != null ? ago(l.claimedAgoMs) : null,
        ago(l.createdAgoMs),
      ],
    );
    const leadId = leadRes.rows[0]!.id;

    for (const m of l.messages) {
      await query(
        `INSERT INTO messages (lead_id, wa_message_id, direction, body, type, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [leadId, `seed_${l.wa_id}_${msgCount++}`, m.direction, m.body, m.type ?? 'text', ago(m.atMs)],
      );
    }

    for (const f of l.followups) {
      await query(
        `INSERT INTO followups (lead_id, send_at, step, channel, template_name, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (lead_id, step) DO NOTHING`,
        [
          leadId,
          f.sendAtMs >= 0 ? ago(f.sendAtMs) : ahead(-f.sendAtMs),
          f.step, f.channel, f.templateName ?? null, f.status, ago(l.createdAgoMs),
        ],
      );
      fuCount++;
    }

    if (l.payment) {
      await query(
        `INSERT INTO payments (lead_id, offer_id, provider, reference, amount, created_at)
         VALUES ($1,$2,'paystack',$3,$4,$5)
         ON CONFLICT (reference) DO NOTHING`,
        [leadId, offerId, l.payment.reference, l.payment.amountKobo, ago(l.createdAgoMs - 60 * 1000)],
      );
      payCount++;
    }
  }

  log.info('seed complete', {
    offers: SEED_OFFERS.length + 1,
    leads: LEADS.length,
    messages: msgCount,
    followups: fuCount,
    payments: payCount,
  });
}

// CLI entrypoint: `npm run seed` runs this file directly. When seed.ts is merely
// imported (e.g. by the app's optional seed-on-boot hook), this block is skipped.
if (import.meta.url === `file://${process.argv[1]}`) {
  seedDatabase()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      log.error('seed failed', { error: (err as Error).message });
      process.exit(1);
    });
}
