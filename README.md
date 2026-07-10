# WhatsApp Lead Engine

A backend + lightweight dashboard that turns click-to-WhatsApp ad leads into an
automated pipeline: **capture → instant reply → 7-day follow-up → auto-remove on
payment.**

Built on the **official WhatsApp Cloud API** (never an unofficial library — that
is the #1 ban vector). Optimized for Nigerian leads and **Paystack** payments.

- No manual work: every lead is auto-added, auto-replied, auto-followed-up for 7
  days, and auto-removed when they pay or opt out.
- Ban-safety enforced in code: window-aware sends, instant opt-out, tapered
  follow-ups, warm-up ramp, and quality-based auto-throttle.

## Architecture

```
Facebook/IG Ad (Click-to-WhatsApp)
        │  user taps "Send message"
        ▼
   WhatsApp (Meta) ──inbound──► POST /webhook/whatsapp
                                    │  upsert Lead, log msg, instant reply,
                                    │  schedule 7-day sequence
   Paystack ────────charge.success─► POST /webhook/paystack
                                    │  match lead, mark PAID, cancel follow-ups
        ┌───────────────────────────┴───────────────┐
        ▼                                            ▼
   PostgreSQL                            WORKER (node-cron, every 60s)
   (leads, messages,                     - find due follow-ups
    followups, payments)                 - skip PAID / OPTED_OUT
                                         - freeform if in window, else template
                                         - daily cap + warm-up + quality throttle
                                                     │
                                                     ▼
                                          WhatsApp Cloud API (outbound)
   DASHBOARD (/) ──► /api/* ──► leads, threads, statuses, counts
```

## Tech stack

| Layer            | Choice                                            |
| ---------------- | ------------------------------------------------- |
| Backend          | Node.js + TypeScript + **Fastify**                |
| Database         | **PostgreSQL** (Supabase-ready)                   |
| Worker           | **node-cron** polling the `followups` table (60s) |
| Messaging        | **WhatsApp Cloud API** (Graph API)                |
| Payments         | **Paystack** (Pay with Transfer / USSD / card)    |
| Dashboard        | Self-contained static SPA hitting `/api/*`        |
| Optional AI      | Claude API inside the inbound handler             |

## Project layout

```
src/
  config.ts              env loading + validation (fail-fast)
  server.ts              Fastify app: raw-body parser, routes, static dashboard
  index.ts               entrypoint: migrate + server + in-process worker
  sequence.ts            the 7-day follow-up sequence (§7) — single source of truth
  db/
    pool.ts              pg pool + Queryable interface + withTransaction
    migrate.ts           forward-only SQL migration runner
    migrations/001_init.sql
  lib/
    crypto.ts            HMAC verify (Meta SHA-256, Paystack SHA-512)
    window.ts            24h / 72h window math
  whatsapp/
    client.ts            Cloud API send (text / template) + DRY_RUN stub
    parse.ts             webhook payload → normalized inbound messages
  paystack/client.ts     Charge API (Pay with Transfer, USSD) + DRY_RUN stub
  ai/reply.ts            optional Claude qualification reply
  services/
    inbound.ts           §6.1 orchestration (dedupe→upsert→optout→reply→schedule)
    leads.ts  messages.ts  followups.ts  outbound.ts  optout.ts
    payments.ts          charge prompt + charge.success handling (§6.3)
    quality.ts           warm-up ramp + daily cap + quality throttle (§10)
  routes/
    whatsapp.ts  paystack.ts  api.ts
  worker/
    worker.ts            the send loop (§6.4) + cron scheduler
    standalone.ts        run the worker as its own process
public/index.html        read-only dashboard
test/                    unit tests (node:test)
```

## Getting started

### 1. Prerequisites

- Node.js ≥ 20
- PostgreSQL (local via `docker compose up -d db`, or a managed instance)

### 2. Configure

```bash
cp .env.example .env
# fill in WA_*, PAYSTACK_SECRET_KEY, DATABASE_URL, etc.
```

For local development without real credentials, set `DRY_RUN=true` — all
outbound HTTP to Meta/Paystack is stubbed and logged instead of sent.

### 3. Install, migrate, run

```bash
npm install
npm run migrate         # apply db/migrations
npm run dev             # server + worker (tsx watch)
# or: npm run build && npm start
```

The dashboard is served at `http://localhost:3000/`.

### 4. Scaling the worker (optional)

Run the sender as its own process instead of in-process:

```bash
npm run worker
```

## How the ban-safety rules are enforced (§10)

| Rule                                   | Where                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| Official Cloud API only                | `whatsapp/client.ts` (Graph API, no unofficial libs)        |
| Warm up the number (increasing cap)    | `quality.rampCap()` × configured `DAILY_SEND_CAP` ceiling   |
| Respect the 24h/72h windows            | `lib/window.ts`, re-checked at schedule **and** send time   |
| Honor opt-out instantly                | `services/optout.ts` + `inbound.ts` (STOP → cancel + exit)  |
| Taper follow-ups                       | `sequence.ts` (7 lean touches, front-loaded in the window)  |
| Monitor quality / auto-slow            | `quality.applyQualityThrottle()` (slows, then pauses)       |
| One clear CTA, personalized            | reply/sequence copy includes name + single CTA + opt-out    |

## Webhooks

### `GET/POST /webhook/whatsapp`

- **GET** — Meta verification handshake. Echoes `hub.challenge` when
  `hub.verify_token` matches `WA_VERIFY_TOKEN`, else `403`.
- **POST** — verifies `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with
  `WA_APP_SECRET`); `401` on mismatch. Responds `200` immediately and processes
  asynchronously: dedupe on `wa_message_id`, upsert lead + window, log message,
  opt-out check, instant reply, schedule the 7-day sequence (first inbound only).

### `POST /webhook/paystack`

Verifies `x-paystack-signature` (HMAC-SHA512 of the raw body with
`PAYSTACK_SECRET_KEY`); `401` on mismatch. Handles `charge.success` only — matches
the lead via `metadata.wa_id` (fallback: stored `reference`), records the payment,
marks the lead **PAID**, cancels pending follow-ups, and sends a receipt
(idempotent: the receipt fires only on the first transition into PAID).

## Dashboard API (`/api/*`)

| Endpoint                        | Purpose                                             |
| ------------------------------- | --------------------------------------------------- |
| `GET /api/stats`                | Top counts + 7-day opt-out rate + send status       |
| `GET /api/leads?status=&source=`| Leads table with filters                            |
| `GET /api/leads/:id`            | Lead detail: thread, follow-ups, payments           |
| `GET /api/sources`              | Distinct ad sources (filter dropdown)               |
| `POST /api/leads/:id/message`   | Manual free-form message (window-gated)             |
| `GET /api/health`               | Liveness                                            |

## Testing

```bash
npm test         # unit tests (pure logic; no DB needed — uses DRY_RUN)
```

Unit tests cover signature verification, window math, opt-out detection, webhook
parsing, sequence/channel resolution, the worker's send decisions, the warm-up
ramp/throttle, and payment copy. The spec's §13 checklist (dedupe, 24h/72h
windows, worker skips PAID/OPTED_OUT, freeform→template fallback, payment marks
PAID + cancels follow-ups, STOP halts sends, daily cap) is additionally verified
end-to-end against a live Postgres during development.

## One-time setup checklists

See the build spec for the full **WhatsApp Cloud API setup** (§8), **Paystack
setup** (§9), and template creation for sequence steps 4–6. Key points:

- Use a **permanent** system-user access token (`WA_ACCESS_TOKEN`), not the 24h
  temp token.
- Create & submit templates `re_engage_still_interested`,
  `final_value_last_chance`, `closeout_soft_goodbye` in WhatsApp Manager and set
  their names in `src/sequence.ts` if you rename them.
- Always pass the lead's `wa_id` in Paystack `metadata` (the Charge client does
  this) so the webhook maps payments back to the exact lead.
