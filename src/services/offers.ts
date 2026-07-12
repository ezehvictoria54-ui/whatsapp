import { query, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import type { Bubble, Offer, OfferSequenceStep } from '../types.js';
import { SEQUENCE } from '../sequence.js';

type Db = Queryable;

/**
 * Normalize a keyword or an inbound body to a comparable form: lowercase, then
 * strip everything that isn't a letter or digit. This makes "OFFER1",
 * "offer 1", and "start offer1!" all normalize such that the keyword "offer1"
 * is found inside them (§Feature A: case-insensitive, ignore extra words/punct).
 */
export function normalize(text: string): string {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The canonical 7-day sequence, as stored on the default offer. */
export function canonicalSequence(): OfferSequenceStep[] {
  return SEQUENCE.map((s) => ({
    step: s.step,
    offsetMs: s.offsetMs,
    channel: s.channel,
    purpose: s.purpose,
    ...(s.freeformBody ? { freeformBody: s.freeformBody } : {}),
    ...(s.templateName ? { templateName: s.templateName } : {}),
  }));
}

/** An offer's sequence, falling back to the canonical one if it has none. */
export function offerSequence(offer: Offer): OfferSequenceStep[] {
  return offer.sequence && offer.sequence.length > 0 ? offer.sequence : canonicalSequence();
}

/**
 * The bubbles a step sends: its explicit `bubbles`, or the legacy single
 * `freeformBody` as one bubble. Empty bodies with no image are dropped.
 */
export function stepBubbles(step: OfferSequenceStep): Bubble[] {
  const raw = step.bubbles && step.bubbles.length > 0
    ? step.bubbles
    : step.freeformBody
      ? [{ body: step.freeformBody }]
      : [];
  return raw.filter((b) => (b.body && b.body.trim() !== '') || (b.imageUrl && b.imageUrl.trim() !== ''));
}

/** The offer's active keyword list (array column, or the legacy single keyword). */
export function offerKeywords(offer: Offer): string[] {
  if (offer.keywords && offer.keywords.length > 0) return offer.keywords;
  return offer.keyword ? [offer.keyword] : [];
}

export async function listOffers(db: Db = { query }): Promise<Offer[]> {
  const res = await db.query<Offer>('SELECT * FROM offers ORDER BY is_default DESC, name ASC');
  return res.rows;
}

export async function getOffer(id: string, db: Db = { query }): Promise<Offer | null> {
  const res = await db.query<Offer>('SELECT * FROM offers WHERE id = $1', [id]);
  return res.rows[0] ?? null;
}

export async function getDefaultOffer(db: Db = { query }): Promise<Offer | null> {
  const res = await db.query<Offer>('SELECT * FROM offers WHERE is_default = true LIMIT 1');
  return res.rows[0] ?? null;
}

/**
 * Find the offer whose keyword appears in the inbound body. Longer keywords win
 * (most specific), so "offer10" is preferred over "offer1". Returns null when no
 * active keyworded offer matches — the caller then uses the default offer and
 * flags the lead as an unmatched offer.
 */
export async function matchOfferByKeyword(body: string, db: Db = { query }): Promise<Offer | null> {
  const norm = normalize(body);
  if (!norm) return null;
  const res = await db.query<Offer>(
    `SELECT * FROM offers
     WHERE active = true AND (cardinality(keywords) > 0 OR (keyword IS NOT NULL AND keyword <> ''))`,
  );
  // Collect every (offer, matched-keyword) pair, then pick the longest keyword
  // so a more specific keyword ("flattummy") beats a broader one ("flat").
  let best: { offer: Offer; len: number } | null = null;
  for (const offer of res.rows) {
    for (const kw of offerKeywords(offer)) {
      const k = normalize(kw);
      if (k && norm.includes(k) && (!best || k.length > best.len)) {
        best = { offer, len: k.length };
      }
    }
  }
  return best?.offer ?? null;
}

/**
 * Ensure a default offer exists (seeded with the canonical sequence) and every
 * lead is attributed to some offer. Idempotent; safe to call on every boot.
 */
export async function ensureDefaultOffer(): Promise<Offer> {
  const existing = await getDefaultOffer();
  let def = existing;
  if (!def) {
    const res = await query<Offer>(
      `INSERT INTO offers (name, price_kobo, keyword, keywords, sequence, is_default, active)
       VALUES ($1, $2, NULL, '{}', $3::jsonb, true, true)
       RETURNING *`,
      ['Default Offer', config.app.defaultOfferPriceKobo, JSON.stringify(canonicalSequence())],
    );
    def = res.rows[0]!;
    log.info('created default offer', { offerId: def.id });
  }
  // Backfill any leads that predate the offers feature.
  const back = await query('UPDATE leads SET offer_id = $1 WHERE offer_id IS NULL', [def.id]);
  if ((back.rowCount ?? 0) > 0) log.info('backfilled leads to default offer', { count: back.rowCount });
  return def;
}

export interface OfferInput {
  name: string;
  priceKobo: number;
  keywords?: string[]; // preferred — multiple keywords per offer
  keyword?: string | null; // legacy single keyword
  sequence?: OfferSequenceStep[];
  active?: boolean;
}

/** Normalize + de-dupe an offer's keyword list from either input form. */
function resolveKeywords(input: Pick<OfferInput, 'keywords' | 'keyword'>): string[] {
  const raw = input.keywords ?? (input.keyword != null ? [input.keyword] : []);
  const out: string[] = [];
  for (const k of raw) {
    const n = normalize(k);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

export async function createOffer(input: OfferInput, db: Db = { query }): Promise<Offer> {
  const keywords = resolveKeywords(input);
  const res = await db.query<Offer>(
    `INSERT INTO offers (name, price_kobo, keyword, keywords, sequence, active)
     VALUES ($1, $2, $3, $4::text[], $5::jsonb, $6)
     RETURNING *`,
    [
      input.name,
      input.priceKobo,
      keywords[0] ?? null, // legacy column = first keyword
      keywords,
      JSON.stringify(input.sequence ?? canonicalSequence()),
      input.active ?? true,
    ],
  );
  return res.rows[0]!;
}

export async function updateOffer(
  id: string,
  patch: Partial<OfferInput>,
  db: Db = { query },
): Promise<Offer | null> {
  const touchKeywords = patch.keywords !== undefined || patch.keyword !== undefined;
  const keywords = touchKeywords ? resolveKeywords(patch) : [];
  const res = await db.query<Offer>(
    `UPDATE offers SET
       name       = COALESCE($2, name),
       price_kobo = COALESCE($3, price_kobo),
       keyword    = CASE WHEN $4::boolean THEN $5 ELSE keyword END,
       keywords   = CASE WHEN $4::boolean THEN $6::text[] ELSE keywords END,
       sequence   = COALESCE($7::jsonb, sequence),
       active     = COALESCE($8, active),
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      patch.name ?? null,
      patch.priceKobo ?? null,
      touchKeywords,
      keywords[0] ?? null,
      keywords,
      patch.sequence ? JSON.stringify(patch.sequence) : null,
      patch.active ?? null,
    ],
  );
  return res.rows[0] ?? null;
}

/**
 * Delete an offer. The default offer can't be deleted. Any leads/payments on the
 * offer are reassigned to the default so nothing is orphaned.
 */
export async function deleteOffer(id: string): Promise<{ deleted: boolean; reason?: string }> {
  const offer = await getOffer(id);
  if (!offer) return { deleted: false, reason: 'not found' };
  if (offer.is_default) return { deleted: false, reason: 'cannot delete the default offer' };

  const def = await ensureDefaultOffer();
  await query('UPDATE leads SET offer_id = $1 WHERE offer_id = $2', [def.id, id]);
  await query('UPDATE payments SET offer_id = $1 WHERE offer_id = $2', [def.id, id]);
  await query('DELETE FROM offers WHERE id = $1', [id]);
  return { deleted: true };
}
