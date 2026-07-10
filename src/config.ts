import 'dotenv/config';

/**
 * Centralised, validated configuration. Fail fast on missing critical vars so a
 * misconfigured deploy never silently sends unsigned/unauthenticated traffic.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function opt(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// When true, outbound HTTP to Meta/Paystack is skipped and stubbed. Lets the
// engine run end-to-end locally without real credentials.
export const DRY_RUN = bool('DRY_RUN', false);

// In dry-run / test we relax the "required" credentials so the process boots.
function credential(name: string): string {
  return DRY_RUN ? opt(name, `dryrun-${name.toLowerCase()}`) : req(name);
}

export const config = {
  dryRun: DRY_RUN,

  whatsapp: {
    phoneNumberId: credential('WA_PHONE_NUMBER_ID'),
    accessToken: credential('WA_ACCESS_TOKEN'),
    appSecret: credential('WA_APP_SECRET'),
    verifyToken: credential('WA_VERIFY_TOKEN'),
    businessAccountId: opt('WA_BUSINESS_ACCOUNT_ID'),
    graphVersion: opt('WA_GRAPH_VERSION', 'v21.0'),
  },

  paystack: {
    secretKey: credential('PAYSTACK_SECRET_KEY'),
  },

  db: {
    url: req('DATABASE_URL'),
  },

  ai: {
    enabled: bool('AI_REPLIES_ENABLED', false),
    apiKey: opt('ANTHROPIC_API_KEY'),
    systemPrompt: opt(
      'AI_SYSTEM_PROMPT',
      'You are a friendly sales assistant. Qualify the lead and answer briefly with one clear call to action.',
    ),
  },

  app: {
    port: int('PORT', 3000),
    baseUrl: opt('BASE_URL', 'http://localhost:3000'),
    dailySendCap: int('DAILY_SEND_CAP', 250),
    warmupStartDate: opt('WARMUP_START_DATE'),
    sendRatePerSec: int('SEND_RATE_PER_SEC', 10),
    businessName: opt('BUSINESS_NAME', 'Our Store'),
    deliveryDetails: opt('DELIVERY_DETAILS', 'We will send your product/next steps shortly.'),
    // When true, the app inserts demo leads on startup (idempotent). Meant as a
    // one-switch way to populate the dashboard from the Railway UI; leave off in
    // real use.
    seedOnBoot: bool('SEED_ON_BOOT', false),
  },
} as const;

export type Config = typeof config;
