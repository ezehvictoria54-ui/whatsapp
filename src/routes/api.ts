import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { getLeadById, getLeadByWaId } from '../services/leads.js';
import { threadForLead } from '../services/messages.js';
import { followupsForLead } from '../services/followups.js';
import { getSendStatus } from '../services/quality.js';
import { sendFreeformToLead } from '../services/outbound.js';
import { isWindowOpen } from '../lib/window.js';
import type { Lead } from '../types.js';

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true }));

  // ─── Leads table (with filters) ─────────────────────────────────────────────
  app.get<{ Querystring: { status?: string; source?: string; limit?: string; offset?: string } }>(
    '/api/leads',
    async (req) => {
      const status = req.query.status ?? null;
      const source = req.query.source ?? null;
      const limit = Math.min(Number.parseInt(req.query.limit ?? '100', 10) || 100, 500);
      const offset = Number.parseInt(req.query.offset ?? '0', 10) || 0;

      const res = await query(
        `SELECT
           l.*,
           COALESCE((SELECT max(created_at) FROM messages m WHERE m.lead_id = l.id), l.created_at)
             AS last_activity,
           (SELECT count(*)::int FROM messages m WHERE m.lead_id = l.id) AS message_count
         FROM leads l
         WHERE ($1::text IS NULL OR l.status = $1)
           AND ($2::text IS NULL OR l.source = $2)
         ORDER BY last_activity DESC
         LIMIT $3 OFFSET $4`,
        [status, source, limit, offset],
      );
      return { leads: res.rows };
    },
  );

  // ─── Lead detail: thread + follow-ups + payments ────────────────────────────
  app.get<{ Params: { id: string } }>('/api/leads/:id', async (req, reply) => {
    const lead = await getLeadById(req.params.id);
    if (!lead) return reply.code(404).send({ error: 'not found' });

    const [messages, followups, payments] = await Promise.all([
      threadForLead(lead.id),
      followupsForLead(lead.id),
      query('SELECT * FROM payments WHERE lead_id = $1 ORDER BY created_at DESC', [lead.id]),
    ]);

    return {
      lead,
      windowOpen: isWindowOpen(lead.window_expires_at),
      messages,
      followups,
      payments: payments.rows,
    };
  });

  // ─── Top counts (§6.5) ──────────────────────────────────────────────────────
  app.get('/api/stats', async () => {
    const sendStatus = await getSendStatus();
    const res = await query<{
      leads_today: number;
      replies_today: number;
      conversions_today: number;
      total_leads: number;
      new_count: number;
      engaged_count: number;
      paid_count: number;
      opted_out_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM leads WHERE created_at >= date_trunc('day', now())) AS leads_today,
         (SELECT count(*)::int FROM messages WHERE direction = 'OUT' AND created_at >= date_trunc('day', now())) AS replies_today,
         (SELECT count(*)::int FROM payments WHERE created_at >= date_trunc('day', now())) AS conversions_today,
         (SELECT count(*)::int FROM leads) AS total_leads,
         (SELECT count(*)::int FROM leads WHERE status = 'NEW') AS new_count,
         (SELECT count(*)::int FROM leads WHERE status = 'ENGAGED') AS engaged_count,
         (SELECT count(*)::int FROM leads WHERE status = 'PAID') AS paid_count,
         (SELECT count(*)::int FROM leads WHERE status = 'OPTED_OUT') AS opted_out_count`,
    );
    return {
      counts: res.rows[0],
      optOutRate7d: sendStatus.optOutRate7d,
      sending: sendStatus,
    };
  });

  // ─── Distinct sources (for the filter dropdown) ─────────────────────────────
  app.get('/api/sources', async () => {
    const res = await query<{ source: string }>(
      `SELECT DISTINCT source FROM leads WHERE source IS NOT NULL ORDER BY source`,
    );
    return { sources: res.rows.map((r) => r.source) };
  });

  // ─── Manual message box (§6.5 "later") ──────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { body?: string } }>(
    '/api/leads/:id/message',
    async (req, reply) => {
      const lead: Lead | null = await getLeadById(req.params.id);
      if (!lead) return reply.code(404).send({ error: 'not found' });
      const body = (req.body?.body ?? '').trim();
      if (!body) return reply.code(400).send({ error: 'body required' });
      if (!isWindowOpen(lead.window_expires_at)) {
        return reply
          .code(409)
          .send({ error: 'messaging window closed — a template is required to reach this lead' });
      }
      await sendFreeformToLead(lead.id, lead.wa_id, body);
      return { ok: true };
    },
  );

  // convenience lookup by wa_id
  app.get<{ Params: { waId: string } }>('/api/leads/by-wa/:waId', async (req, reply) => {
    const lead = await getLeadByWaId(req.params.waId);
    if (!lead) return reply.code(404).send({ error: 'not found' });
    return { lead };
  });
}
