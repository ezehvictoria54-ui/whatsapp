import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { getLeadById, getLeadByWaId, assignOffer } from '../services/leads.js';
import { threadForLead } from '../services/messages.js';
import { followupsForLead } from '../services/followups.js';
import { getSendStatus } from '../services/quality.js';
import { sendFreeformToLead } from '../services/outbound.js';
import {
  listOffers,
  getOffer,
  createOffer,
  updateOffer,
  deleteOffer,
  canonicalSequence,
} from '../services/offers.js';
import { approveClaim, rejectClaim } from '../services/payments.js';
import { isWindowOpen } from '../lib/window.js';
import type { Lead, OfferSequenceStep } from '../types.js';

// Common SELECT that decorates a lead with its offer name/price.
const LEAD_WITH_OFFER = `
  l.*,
  o.name       AS offer_name,
  o.price_kobo AS offer_price_kobo`;

// last-activity expression reused by the leads query (max message time or created).
const LAST_ACTIVITY = `COALESCE((SELECT max(created_at) FROM messages m WHERE m.lead_id = l.id), l.created_at)`;

/**
 * Parse ?from=YYYY-MM-DD&to=YYYY-MM-DD into an inclusive [start, end] pair of SQL
 * params (or null → "default to today" handled in each query's COALESCE). This is
 * the same convention the revenue endpoint uses, so the whole dashboard shares
 * one date-range language.
 */
function rangeParams(q: { from?: string; to?: string }): { from: string | null; to: string | null } {
  return {
    from: q.from ? `${q.from}T00:00:00` : null,
    to: q.to ? `${q.to}T23:59:59.999` : null,
  };
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true }));

  // ─── Leads table (with filters) ─────────────────────────────────────────────
  app.get<{
    Querystring: { status?: string; source?: string; offer?: string; unmatched?: string; from?: string; to?: string; limit?: string; offset?: string };
  }>('/api/leads', async (req) => {
    const status = req.query.status ?? null;
    const source = req.query.source ?? null;
    const offer = req.query.offer ?? null;
    const unmatched = req.query.unmatched === 'true' ? true : null;
    const limit = Math.min(Number.parseInt(req.query.limit ?? '100', 10) || 100, 500);
    const offset = Number.parseInt(req.query.offset ?? '0', 10) || 0;
    const { from, to } = rangeParams(req.query);

    // Date filter is on last activity so the list shows leads active in the
    // selected period (new + still-moving), consistent with the global picker.
    const res = await query(
      `SELECT ${LEAD_WITH_OFFER},
         ${LAST_ACTIVITY} AS last_activity,
         (SELECT count(*)::int FROM messages m WHERE m.lead_id = l.id) AS message_count
       FROM leads l
       LEFT JOIN offers o ON o.id = l.offer_id
       WHERE ($1::text IS NULL OR l.status = $1)
         AND ($2::text IS NULL OR l.source = $2)
         AND ($3::uuid IS NULL OR l.offer_id = $3)
         AND ($4::boolean IS NULL OR l.offer_unmatched = $4)
         AND ${LAST_ACTIVITY} BETWEEN COALESCE($7::timestamp, date_trunc('day', now()))
                                  AND COALESCE($8::timestamp, now())
       ORDER BY last_activity DESC
       LIMIT $5 OFFSET $6`,
      [status, source, offer, unmatched, limit, offset, from, to],
    );
    return { leads: res.rows };
  });

  // ─── Lead detail: thread + follow-ups + payments (+offer) ───────────────────
  app.get<{ Params: { id: string } }>('/api/leads/:id', async (req, reply) => {
    const lead = await getLeadById(req.params.id);
    if (!lead) return reply.code(404).send({ error: 'not found' });

    const [messages, followups, payments, offer] = await Promise.all([
      threadForLead(lead.id),
      followupsForLead(lead.id),
      query(
        `SELECT p.*, o.name AS offer_name FROM payments p
         LEFT JOIN offers o ON o.id = p.offer_id
         WHERE p.lead_id = $1 ORDER BY p.created_at DESC`,
        [lead.id],
      ),
      lead.offer_id ? getOffer(lead.offer_id) : Promise.resolve(null),
    ]);

    return {
      lead,
      offer,
      windowOpen: isWindowOpen(lead.window_expires_at),
      messages,
      followups,
      payments: payments.rows,
    };
  });

  // ─── Top counts (range-aware — driven by the global date picker) ────────────
  // Every card reflects the selected [from, to] (default: today). Two "live_"
  // fields stay point-in-time for the always-current review queues.
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/stats', async (req) => {
    const sendStatus = await getSendStatus();
    const { from, to } = rangeParams(req.query);
    const res = await query<{
      leads: number; replies: number; conversions: number; revenue_kobo: number;
      claims: number; unmatched: number; opted_out: number; contacted: number;
      live_claims: number; live_unmatched: number;
    }>(
      `WITH r AS (
         SELECT COALESCE($1::timestamp, date_trunc('day', now())) AS s,
                COALESCE($2::timestamp, now())                    AS e )
       SELECT
         (SELECT count(*)::int  FROM leads, r    WHERE created_at BETWEEN s AND e) AS leads,
         (SELECT count(*)::int  FROM messages, r WHERE direction='OUT' AND created_at BETWEEN s AND e) AS replies,
         (SELECT count(*)::int  FROM payments, r WHERE created_at BETWEEN s AND e) AS conversions,
         (SELECT COALESCE(sum(amount),0)::bigint FROM payments, r WHERE created_at BETWEEN s AND e) AS revenue_kobo,
         (SELECT count(*)::int  FROM leads, r    WHERE payment_claimed_at BETWEEN s AND e) AS claims,
         (SELECT count(*)::int  FROM leads, r    WHERE offer_unmatched = true AND status NOT IN ('PAID','OPTED_OUT') AND created_at BETWEEN s AND e) AS unmatched,
         (SELECT count(*)::int  FROM leads, r    WHERE status='OPTED_OUT' AND updated_at BETWEEN s AND e) AS opted_out,
         (SELECT count(DISTINCT lead_id)::int FROM messages, r WHERE direction='OUT' AND created_at BETWEEN s AND e) AS contacted,
         (SELECT count(*)::int  FROM leads WHERE status='PAYMENT_CLAIMED') AS live_claims,
         (SELECT count(*)::int  FROM leads WHERE offer_unmatched = true AND status NOT IN ('PAID','OPTED_OUT')) AS live_unmatched`,
      [from, to],
    );
    const c = res.rows[0]!;
    const optOutRate = c.contacted > 0 ? c.opted_out / c.contacted : 0;
    return {
      counts: { ...c, revenue_kobo: Number(c.revenue_kobo) },
      optOutRate,
      liveClaims: c.live_claims,
      liveUnmatched: c.live_unmatched,
      sending: sendStatus,
    };
  });

  // ─── Payment-claim review queue (Feature B) ─────────────────────────────────
  app.get('/api/claims', async () => {
    const res = await query(
      `SELECT l.id, l.name, l.wa_id, l.payment_claimed_at, l.offer_id,
              o.name AS offer_name, o.price_kobo AS offer_price_kobo
       FROM leads l
       LEFT JOIN offers o ON o.id = l.offer_id
       WHERE l.status = 'PAYMENT_CLAIMED'
       ORDER BY l.payment_claimed_at ASC`,
    );
    return { claims: res.rows };
  });

  app.post<{ Params: { id: string } }>('/api/claims/:id/approve', async (req, reply) => {
    const result = await approveClaim(req.params.id);
    if (!result.ok) return reply.code(409).send({ error: result.reason ?? 'could not approve' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/claims/:id/reject', async (req, reply) => {
    const result = await rejectClaim(req.params.id);
    if (!result.ok) return reply.code(409).send({ error: result.reason ?? 'could not reject' });
    return { ok: true };
  });

  // ─── Revenue report (approved/recorded payments), by offer, date range ──────
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/revenue', async (req) => {
    // Default range: today (server-local day).
    const from = req.query.from ? `${req.query.from}T00:00:00` : null;
    const to = req.query.to ? `${req.query.to}T23:59:59.999` : null;

    const res = await query<{
      offer_id: string | null;
      offer_name: string | null;
      sales: number;
      revenue_kobo: number;
    }>(
      `SELECT p.offer_id,
              COALESCE(o.name, 'Unassigned') AS offer_name,
              count(*)::int AS sales,
              COALESCE(sum(p.amount), 0)::bigint AS revenue_kobo
       FROM payments p
       LEFT JOIN offers o ON o.id = p.offer_id
       WHERE p.created_at >= COALESCE($1::timestamp, date_trunc('day', now()))
         AND p.created_at <= COALESCE($2::timestamp, now())
       GROUP BY p.offer_id, o.name
       ORDER BY revenue_kobo DESC`,
      [from, to],
    );

    const byOffer = res.rows.map((r) => ({
      offerId: r.offer_id,
      offerName: r.offer_name,
      sales: r.sales,
      revenueKobo: Number(r.revenue_kobo),
    }));
    const totalKobo = byOffer.reduce((s, r) => s + r.revenueKobo, 0);
    const totalSales = byOffer.reduce((s, r) => s + r.sales, 0);
    return {
      from: req.query.from ?? 'today',
      to: req.query.to ?? 'today',
      byOffer,
      totalKobo,
      totalSales,
    };
  });

  // ─── Offers CRUD (Feature A) ────────────────────────────────────────────────
  app.get('/api/offers', async () => {
    const offers = await listOffers();
    // annotate with lead counts for the management table
    const counts = await query<{ offer_id: string; n: number }>(
      `SELECT offer_id, count(*)::int AS n FROM leads WHERE offer_id IS NOT NULL GROUP BY offer_id`,
    );
    const byId = new Map(counts.rows.map((r) => [r.offer_id, r.n]));
    return { offers: offers.map((o) => ({ ...o, lead_count: byId.get(o.id) ?? 0 })) };
  });

  app.get('/api/offers/template', async () => ({ sequence: canonicalSequence() }));

  app.post<{ Body: { name?: string; priceKobo?: number; keyword?: string | null; sequence?: OfferSequenceStep[]; active?: boolean } }>(
    '/api/offers',
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.name || typeof b.priceKobo !== 'number') {
        return reply.code(400).send({ error: 'name and priceKobo are required' });
      }
      try {
        const offer = await createOffer({
          name: b.name,
          priceKobo: b.priceKobo,
          keyword: b.keyword ?? null,
          sequence: b.sequence,
          active: b.active,
        });
        return { offer };
      } catch (err) {
        return reply.code(409).send({ error: `could not create offer: ${(err as Error).message}` });
      }
    },
  );

  app.put<{ Params: { id: string }; Body: Partial<{ name: string; priceKobo: number; keyword: string | null; sequence: OfferSequenceStep[]; active: boolean }> }>(
    '/api/offers/:id',
    async (req, reply) => {
      try {
        const offer = await updateOffer(req.params.id, req.body ?? {});
        if (!offer) return reply.code(404).send({ error: 'not found' });
        return { offer };
      } catch (err) {
        return reply.code(409).send({ error: `could not update offer: ${(err as Error).message}` });
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/offers/:id', async (req, reply) => {
    const result = await deleteOffer(req.params.id);
    if (!result.deleted) return reply.code(409).send({ error: result.reason ?? 'could not delete' });
    return { ok: true };
  });

  // Manually (re)assign a lead to an offer (e.g. after an unmatched keyword).
  app.post<{ Params: { id: string }; Body: { offerId?: string } }>(
    '/api/leads/:id/offer',
    async (req, reply) => {
      const lead = await getLeadById(req.params.id);
      if (!lead) return reply.code(404).send({ error: 'not found' });
      const offerId = req.body?.offerId;
      if (!offerId || !(await getOffer(offerId))) {
        return reply.code(400).send({ error: 'valid offerId required' });
      }
      await assignOffer(lead.id, offerId);
      return { ok: true };
    },
  );

  // ─── Distinct sources (for the filter dropdown) ─────────────────────────────
  app.get('/api/sources', async () => {
    const res = await query<{ source: string }>(
      `SELECT DISTINCT source FROM leads WHERE source IS NOT NULL ORDER BY source`,
    );
    return { sources: res.rows.map((r) => r.source) };
  });

  // ─── Manual message box ─────────────────────────────────────────────────────
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

  app.get<{ Params: { waId: string } }>('/api/leads/by-wa/:waId', async (req, reply) => {
    const lead = await getLeadByWaId(req.params.waId);
    if (!lead) return reply.code(404).send({ error: 'not found' });
    return { lead };
  });
}
