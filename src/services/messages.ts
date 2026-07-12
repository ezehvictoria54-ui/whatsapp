import { query, type Queryable } from '../db/pool.js';
import type { Direction, Message } from '../types.js';

type Db = Queryable;

/** True if we've already stored this Meta message id (webhook re-delivery). */
export async function messageExists(waMessageId: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM messages WHERE wa_message_id = $1', [waMessageId]);
  return res.rowCount !== null && res.rowCount > 0;
}

export interface LogMessageInput {
  leadId: string;
  direction: Direction;
  body: string | null;
  type?: string;
  waMessageId?: string | null;
  imageUrl?: string | null;
}

/**
 * Insert a message row. `ON CONFLICT (wa_message_id) DO NOTHING` makes inbound
 * logging idempotent against Meta's at-least-once webhook delivery. Returns the
 * inserted row, or null if it was a duplicate.
 */
export async function logMessage(input: LogMessageInput, db: Db = { query }): Promise<Message | null> {
  const res = await db.query<Message>(
    `INSERT INTO messages (lead_id, direction, body, type, wa_message_id, image_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING *`,
    [input.leadId, input.direction, input.body, input.type ?? 'text', input.waMessageId ?? null, input.imageUrl ?? null],
  );
  return res.rows[0] ?? null;
}

export async function threadForLead(leadId: string, limit = 200): Promise<Message[]> {
  const res = await query<Message>(
    `SELECT * FROM messages WHERE lead_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [leadId, limit],
  );
  return res.rows;
}
