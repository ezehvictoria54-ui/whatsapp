import { query, type Queryable } from '../db/pool.js';
import type { Channel, Followup, OfferSequenceStep } from '../types.js';
import { renderMessage, type RenderContext } from '../lib/render.js';

type Db = Queryable;

/** Minimal shape resolveChannel needs — satisfied by any sequence step. */
type ChannelStep = { channel: Channel; templateName?: string };

/**
 * Decide the channel a step should be scheduled on, given when it will fire
 * relative to the lead's current window (§6.4):
 *   - inside the window  → FREEFORM
 *   - outside the window → TEMPLATE (only if the step has a template to use)
 *   - outside + no template → FREEFORM, and the worker will SKIP it if the
 *     window is still closed at send time.
 */
export function resolveChannel(
  step: ChannelStep,
  sendAt: Date,
  windowExpiresAt: Date | null,
): { channel: Channel; templateName: string | null } {
  const withinWindow = windowExpiresAt !== null && sendAt.getTime() < windowExpiresAt.getTime();

  if (step.channel === 'TEMPLATE') {
    return { channel: 'TEMPLATE', templateName: step.templateName ?? null };
  }
  // FREEFORM-intended step:
  if (withinWindow) return { channel: 'FREEFORM', templateName: null };
  if (step.templateName) return { channel: 'TEMPLATE', templateName: step.templateName };
  return { channel: 'FREEFORM', templateName: null };
}

/**
 * Insert the follow-up sequence for a lead using the lead's *offer* sequence
 * (§Feature A). Step 0 is the instant reply; the worker owns steps ≥ 1. The
 * per-offer free-form body is rendered (placeholders resolved) and stored on the
 * row so the worker doesn't need the offer at send time.
 *
 * Idempotent: `ON CONFLICT (lead_id, step) DO NOTHING`.
 */
export async function scheduleSequence(
  leadId: string,
  firstContact: Date,
  windowExpiresAt: Date | null,
  steps: OfferSequenceStep[],
  ctx: RenderContext,
  db: Db = { query },
): Promise<number> {
  let inserted = 0;
  for (const step of steps) {
    if (step.step < 1) continue; // step 0 is the instant reply, not a worker followup
    const sendAt = new Date(firstContact.getTime() + step.offsetMs);
    const { channel, templateName } = resolveChannel(step, sendAt, windowExpiresAt);
    const body = step.freeformBody ? renderMessage(step.freeformBody, ctx) : null;
    const res = await db.query(
      `INSERT INTO followups (lead_id, send_at, step, channel, template_name, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (lead_id, step) DO NOTHING`,
      [leadId, sendAt.toISOString(), step.step, channel, templateName, body],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

/** Load due (PENDING, send_at <= now) followups, oldest first. */
export async function dueFollowups(limit: number, now: Date = new Date()): Promise<Followup[]> {
  const res = await query<Followup>(
    `SELECT * FROM followups
     WHERE status = 'PENDING' AND send_at <= $1
     ORDER BY send_at ASC
     LIMIT $2`,
    [now.toISOString(), limit],
  );
  return res.rows;
}

/**
 * Atomically claim a followup for sending: flip PENDING → SENT and return the
 * row only if we won the race. This makes the worker safe to run concurrently
 * and idempotent across restarts (§6.4 idempotency note).
 */
export async function claimFollowup(id: string, db: Db = { query }): Promise<boolean> {
  const res = await db.query(
    `UPDATE followups SET status = 'SENT' WHERE id = $1 AND status = 'PENDING'`,
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function markFollowup(
  id: string,
  status: Followup['status'],
  db: Db = { query },
): Promise<void> {
  await db.query('UPDATE followups SET status = $2 WHERE id = $1', [id, status]);
}

/** Cancel every still-pending followup for a lead (on PAID / OPTED_OUT). */
export async function cancelPendingFollowups(leadId: string, db: Db = { query }): Promise<number> {
  const res = await db.query(
    `UPDATE followups SET status = 'CANCELLED'
     WHERE lead_id = $1 AND status = 'PENDING'`,
    [leadId],
  );
  return res.rowCount ?? 0;
}

export async function followupsForLead(leadId: string): Promise<Followup[]> {
  const res = await query<Followup>(
    `SELECT * FROM followups WHERE lead_id = $1 ORDER BY step ASC`,
    [leadId],
  );
  return res.rows;
}
