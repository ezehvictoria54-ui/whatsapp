-- Per-message images, multi-bubble steps, and multi-keyword offer matching.

-- ─── offers: multiple keywords per offer ───────────────────────────────────────
ALTER TABLE offers ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}';

-- Backfill the array from the legacy single keyword column.
UPDATE offers
   SET keywords = ARRAY[keyword]
 WHERE keyword IS NOT NULL AND keyword <> '' AND keywords = '{}';

-- ─── followups: 2–3 bubbles per step, each optionally with an image ─────────────
-- Shape: jsonb array of { "body": text|null, "imageUrl": text|null }.
-- Null → fall back to the single `body`/canonical sequence (older rows).
ALTER TABLE followups ADD COLUMN IF NOT EXISTS bubbles jsonb;

-- ─── messages: optional attached image (before/after photo) ────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_url text;
