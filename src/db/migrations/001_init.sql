-- WhatsApp Lead Engine — initial schema
-- Mirrors §4 of the build spec. Enums are kept as CHECK constraints so the
-- schema is easy to reason about and to extend without ALTER TYPE dances.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ─── leads ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id              text NOT NULL UNIQUE,                 -- E.164 digits (no +)
  name               text,                                 -- webhook profile.name
  source             text,                                 -- ad/campaign id (referral payload)
  status             text NOT NULL DEFAULT 'NEW'
                       CHECK (status IN ('NEW','ENGAGED','PAID','OPTED_OUT')),
  window_expires_at  timestamptz,                          -- 24h from last inbound (72h if ad-initiated)
  entry_point        text NOT NULL DEFAULT 'organic'
                       CHECK (entry_point IN ('ad','organic')),
  sequence_step      int NOT NULL DEFAULT 0,               -- index into the follow-up sequence
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads (source);

-- ─── messages (full thread log) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  wa_message_id  text UNIQUE,                              -- dedupe key; Meta re-delivers webhooks
  direction      text NOT NULL CHECK (direction IN ('IN','OUT')),
  body           text,
  type           text NOT NULL DEFAULT 'text',            -- text, template, image, etc.
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages (lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_out_created ON messages (created_at) WHERE direction = 'OUT';

-- ─── followups (the schedule) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS followups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  send_at        timestamptz NOT NULL,                     -- when this step is due
  step           int NOT NULL,                             -- which sequence step
  channel        text NOT NULL CHECK (channel IN ('FREEFORM','TEMPLATE')),
  template_name  text,                                     -- required if channel = TEMPLATE
  status         text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','SENT','SKIPPED','CANCELLED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- a lead should have at most one row per sequence step (idempotent scheduling)
  UNIQUE (lead_id, step)
);

CREATE INDEX IF NOT EXISTS idx_followups_due
  ON followups (send_at)
  WHERE status = 'PENDING';

-- ─── payments ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid REFERENCES leads (id) ON DELETE SET NULL,
  provider    text NOT NULL DEFAULT 'paystack',           -- paystack / selar
  reference   text NOT NULL UNIQUE,                        -- provider transaction ref (dedupe)
  amount      int,                                         -- in kobo
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_lead ON payments (lead_id);
