-- Feature A (multi-offer) + Feature B (manual payment-claim flow)

-- ─── offers ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS offers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  price_kobo  int  NOT NULL DEFAULT 0,
  keyword     text,                        -- normalized (lowercased, alnum) match key; null for default
  sequence    jsonb NOT NULL DEFAULT '[]', -- per-offer follow-up sequence (same shape as the canonical one)
  is_default  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- keyword unique among the offers that have one
CREATE UNIQUE INDEX IF NOT EXISTS uniq_offer_keyword ON offers (keyword) WHERE keyword IS NOT NULL;
-- at most one default offer
CREATE UNIQUE INDEX IF NOT EXISTS one_default_offer ON offers (is_default) WHERE is_default;

-- ─── leads: offer tagging + payment-claim review state ─────────────────────────
ALTER TABLE leads ADD COLUMN IF NOT EXISTS offer_id uuid REFERENCES offers (id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS offer_unmatched boolean NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS payment_claimed_at timestamptz;

-- extend the status enum with the (non-terminal, reversible) PAYMENT_CLAIMED review state
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
  CHECK (status IN ('NEW','ENGAGED','PAID','OPTED_OUT','PAYMENT_CLAIMED'));

CREATE INDEX IF NOT EXISTS idx_leads_offer ON leads (offer_id);
CREATE INDEX IF NOT EXISTS idx_leads_claimed ON leads (payment_claimed_at) WHERE status = 'PAYMENT_CLAIMED';

-- ─── followups: store the resolved per-offer body ──────────────────────────────
-- Worker sends this body for FREEFORM steps; falls back to the canonical
-- sequence when null (keeps pre-existing rows working).
ALTER TABLE followups ADD COLUMN IF NOT EXISTS body text;

-- ─── payments: attribute revenue to an offer + support manual approvals ─────────
ALTER TABLE payments ADD COLUMN IF NOT EXISTS offer_id uuid REFERENCES offers (id) ON DELETE SET NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS claimed_at timestamptz; -- when the buyer claimed (manual flow)

CREATE INDEX IF NOT EXISTS idx_payments_offer ON payments (offer_id);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments (created_at);
