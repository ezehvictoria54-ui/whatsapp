import { query, type Queryable } from '../db/pool.js';
import type { EntryPoint, Lead, LeadStatus } from '../types.js';

type Db = Queryable;

export async function getLeadById(id: string, db: Db = { query }): Promise<Lead | null> {
  const res = await db.query<Lead>('SELECT * FROM leads WHERE id = $1', [id]);
  return res.rows[0] ?? null;
}

export async function getLeadByWaId(waId: string, db: Db = { query }): Promise<Lead | null> {
  const res = await db.query<Lead>('SELECT * FROM leads WHERE wa_id = $1', [waId]);
  return res.rows[0] ?? null;
}

export interface UpsertInboundInput {
  waId: string;
  name: string | null;
  entryPoint: EntryPoint;
  source: string | null;
  at?: Date;
}

export interface UpsertResult {
  lead: Lead;
  isNew: boolean;
}

/**
 * Upsert a lead on an inbound message (§5).
 *
 * New lead  → status NEW, window set from entry point (72h ad / 24h organic).
 * Existing  → reset the window; bump name/source if newly known. Terminal
 *             statuses (PAID/OPTED_OUT) are preserved — an inbound from a PAID
 *             lead should not silently reactivate outreach here; only explicit
 *             transitions do that.
 *
 * `entry_point` is only ever upgraded organic→ad, never downgraded, so a lead
 * that first arrived via an ad keeps its 72h characteristics.
 */
export async function upsertLeadOnInbound(
  input: UpsertInboundInput,
  db: Db = { query },
): Promise<UpsertResult> {
  const at = (input.at ?? new Date()).toISOString();

  // The messaging window is derived in SQL from the *resolved* entry point so
  // an existing ad lead keeps its 72h window even on a later organic inbound.
  // `entry_point` only ever upgrades organic → ad, never the reverse.
  const res = await db.query<Lead & { xmax_is_new: boolean }>(
    `INSERT INTO leads (wa_id, name, source, entry_point, status, window_expires_at)
     VALUES ($1, $2, $3, $4, 'NEW',
             $5::timestamptz + (CASE WHEN $4 = 'ad'
                                     THEN interval '72 hours'
                                     ELSE interval '24 hours' END))
     ON CONFLICT (wa_id) DO UPDATE SET
       name              = COALESCE(EXCLUDED.name, leads.name),
       source            = COALESCE(leads.source, EXCLUDED.source),
       entry_point       = CASE WHEN EXCLUDED.entry_point = 'ad' THEN 'ad' ELSE leads.entry_point END,
       window_expires_at = $5::timestamptz + (
         CASE WHEN (CASE WHEN EXCLUDED.entry_point = 'ad' THEN 'ad' ELSE leads.entry_point END) = 'ad'
              THEN interval '72 hours'
              ELSE interval '24 hours' END),
       updated_at        = now()
     RETURNING *, (xmax = 0) AS xmax_is_new`,
    [input.waId, input.name, input.source, input.entryPoint, at],
  );

  const row = res.rows[0]!;
  const isNew = row.xmax_is_new === true;
  const { xmax_is_new, ...lead } = row;
  return { lead: lead as Lead, isNew };
}

export async function setStatus(
  leadId: string,
  status: LeadStatus,
  db: Db = { query },
): Promise<void> {
  await db.query('UPDATE leads SET status = $2, updated_at = now() WHERE id = $1', [leadId, status]);
}

/**
 * Move a NEW lead to ENGAGED. Never downgrades and never touches terminal
 * statuses (PAID / OPTED_OUT).
 */
export async function ensureEngaged(leadId: string, db: Db = { query }): Promise<void> {
  await db.query(
    `UPDATE leads SET status = 'ENGAGED', updated_at = now()
     WHERE id = $1 AND status = 'NEW'`,
    [leadId],
  );
}

export async function advanceSequenceStep(
  leadId: string,
  step: number,
  db: Db = { query },
): Promise<void> {
  await db.query(
    `UPDATE leads SET sequence_step = GREATEST(sequence_step, $2), updated_at = now()
     WHERE id = $1`,
    [leadId, step],
  );
}
