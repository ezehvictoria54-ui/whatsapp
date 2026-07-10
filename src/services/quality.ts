import { query } from '../db/pool.js';
import { config } from '../config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Time-based warm-up ramp (§10.2). Returns the automatic daily allowance for a
 * given number of days since the number started warming up. The tiers loosely
 * track Meta's messaging tiers (250 → 1K → 10K → 100K) but on a conservative
 * schedule we fully control. The configured DAILY_SEND_CAP acts as a hard
 * ceiling on top of this — see effectiveCap().
 */
export function rampCap(daysSinceWarmup: number): number {
  if (daysSinceWarmup < 2) return 250;
  if (daysSinceWarmup < 5) return 500;
  if (daysSinceWarmup < 8) return 1_000;
  if (daysSinceWarmup < 12) return 5_000;
  if (daysSinceWarmup < 16) return 10_000;
  if (daysSinceWarmup < 21) return 50_000;
  return 100_000;
}

/**
 * Quality-based throttle (§10.6). As the trailing opt-out rate climbs we shrink
 * the cap; past a hard threshold we pause sending entirely (return 0) so a bad
 * batch can't drag the number's quality rating down further.
 */
export function applyQualityThrottle(cap: number, optOutRate7d: number): number {
  if (optOutRate7d >= 0.15) return 0; // pause — something is badly wrong
  if (optOutRate7d >= 0.08) return Math.floor(cap * 0.25); // heavy slow-down
  if (optOutRate7d >= 0.04) return Math.floor(cap * 0.5); // caution
  return cap;
}

function daysSinceWarmup(now: Date): number {
  const start = config.app.warmupStartDate
    ? new Date(config.app.warmupStartDate)
    : new Date(); // no configured start → treat as day 0 (most conservative)
  if (Number.isNaN(start.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - start.getTime()) / DAY_MS));
}

/** Count OUT messages sent since UTC midnight today. */
export async function outboundSentToday(now: Date = new Date()): Promise<number> {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const res = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM messages
     WHERE direction = 'OUT' AND created_at >= $1`,
    [midnight.toISOString()],
  );
  return res.rows[0]?.count ?? 0;
}

/**
 * Trailing 7-day opt-out rate: leads that opted out in the window divided by
 * distinct leads we sent outbound messages to in the same window. Returns 0 when
 * there's no outreach to divide by (avoids a divide-by-zero pausing sends).
 */
export async function optOutRate7d(now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const res = await query<{ opted_out: number; contacted: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM leads
          WHERE status = 'OPTED_OUT' AND updated_at >= $1) AS opted_out,
       (SELECT COUNT(DISTINCT lead_id)::int FROM messages
          WHERE direction = 'OUT' AND created_at >= $1) AS contacted`,
    [since],
  );
  const optedOut = res.rows[0]?.opted_out ?? 0;
  const contacted = res.rows[0]?.contacted ?? 0;
  if (contacted === 0) return 0;
  return optedOut / contacted;
}

export interface SendStatus {
  sentToday: number;
  rampCap: number;
  configuredCap: number;
  optOutRate7d: number;
  effectiveCap: number;
  remaining: number;
  paused: boolean;
}

/**
 * The single source of truth for "can the worker send right now, and how much".
 * effectiveCap = min(rampCap, configured ceiling), then quality-throttled.
 */
export async function getSendStatus(now: Date = new Date()): Promise<SendStatus> {
  const [sentToday, rate] = await Promise.all([outboundSentToday(now), optOutRate7d(now)]);
  const ramp = rampCap(daysSinceWarmup(now));
  const configuredCap = config.app.dailySendCap;
  const throttled = applyQualityThrottle(Math.min(ramp, configuredCap), rate);
  const remaining = Math.max(0, throttled - sentToday);
  return {
    sentToday,
    rampCap: ramp,
    configuredCap,
    optOutRate7d: rate,
    effectiveCap: throttled,
    remaining,
    paused: throttled === 0,
  };
}
