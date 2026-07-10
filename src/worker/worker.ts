import cron from 'node-cron';
import { config } from '../config.js';
import { log } from '../logger.js';
import { getLeadById, advanceSequenceStep } from '../services/leads.js';
import {
  dueFollowups,
  claimFollowup,
  markFollowup,
} from '../services/followups.js';
import { getSendStatus } from '../services/quality.js';
import { sendFreeformToLead, sendTemplateToLead } from '../services/outbound.js';
import { stepByNumber } from '../sequence.js';
import { isWindowOpen } from '../lib/window.js';
import type { Followup } from '../types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SendAction {
  kind: 'freeform' | 'template' | 'skip';
  body?: string;
  templateName?: string;
  preview?: string;
}

/**
 * Decide what (if anything) to send for a due followup, re-checking the window
 * at send time (§6.4). A FREEFORM step whose window has closed falls back to its
 * template if it has one, else is skipped.
 */
export function resolveSendAction(followup: Followup, windowOpen: boolean): SendAction {
  const step = stepByNumber(followup.step);

  if (followup.channel === 'FREEFORM') {
    if (windowOpen) {
      return { kind: 'freeform', body: step?.freeformBody ?? '' };
    }
    if (step?.templateName) {
      return {
        kind: 'template',
        templateName: step.templateName,
        preview: `[template:${step.templateName}] ${step.purpose}`,
      };
    }
    return { kind: 'skip' };
  }

  // TEMPLATE channel.
  const name = followup.template_name ?? step?.templateName;
  if (name) {
    return {
      kind: 'template',
      templateName: name,
      preview: `[template:${name}] ${step?.purpose ?? ''}`.trim(),
    };
  }
  return { kind: 'skip' };
}

export interface TickResult {
  considered: number;
  sent: number;
  skipped: number;
  budgetRemaining: number;
  paused: boolean;
}

/**
 * One worker pass (§6.4). Loads due follow-ups, applies paid/opt-out/window/cap
 * logic, and sends. Returns counts for observability/testing.
 */
export async function runTick(now: Date = new Date()): Promise<TickResult> {
  const status = await getSendStatus(now);
  let budget = status.remaining;

  // Fetch a bounded batch. We fetch more than `budget` so terminal-skip rows
  // (which don't consume budget) still get cleaned up each tick.
  const batch = await dueFollowups(500, now);
  let sent = 0;
  let skipped = 0;

  for (const f of batch) {
    const lead = await getLeadById(f.lead_id);

    // Skip PAID / OPTED_OUT / vanished leads — no cap consumed.
    if (!lead || lead.status === 'PAID' || lead.status === 'OPTED_OUT') {
      await markFollowup(f.id, 'SKIPPED');
      skipped++;
      continue;
    }

    const windowOpen = isWindowOpen(lead.window_expires_at, now);
    const action = resolveSendAction(f, windowOpen);

    if (action.kind === 'skip') {
      await markFollowup(f.id, 'SKIPPED');
      skipped++;
      continue;
    }

    // Real send — respect the daily cap / pause. Leave PENDING for a later tick.
    if (budget <= 0) continue;

    // Atomically claim (PENDING → SENT) so a restart/second worker can't double-send.
    const claimed = await claimFollowup(f.id);
    if (!claimed) continue;

    try {
      if (action.kind === 'freeform') {
        await sendFreeformToLead(lead.id, lead.wa_id, action.body ?? '');
      } else {
        await sendTemplateToLead(
          lead.id,
          lead.wa_id,
          action.templateName!,
          [lead.name?.split(' ')[0] ?? 'there'],
          action.preview ?? '',
        );
      }
      await advanceSequenceStep(lead.id, f.step);
      budget--;
      sent++;
    } catch (err) {
      // Revert so the row is retried on the next tick.
      await markFollowup(f.id, 'PENDING');
      log.error('followup send failed, will retry', {
        followupId: f.id,
        error: (err as Error).message,
      });
    }

    // Rate-limit outbound sends to protect quality / respect API limits.
    if (config.app.sendRatePerSec > 0) {
      await sleep(Math.floor(1000 / config.app.sendRatePerSec));
    }
  }

  const result: TickResult = {
    considered: batch.length,
    sent,
    skipped,
    budgetRemaining: budget,
    paused: status.paused,
  };
  log.info('worker tick', { ...result, optOutRate7d: status.optOutRate7d });
  return result;
}

let task: cron.ScheduledTask | null = null;

/** Start the cron worker (every 60s). Guards against overlapping ticks. */
export function startWorker(): void {
  let running = false;
  task = cron.schedule('*/1 * * * *', async () => {
    if (running) {
      log.warn('worker tick still running, skipping this minute');
      return;
    }
    running = true;
    try {
      await runTick();
    } catch (err) {
      log.error('worker tick crashed', { error: (err as Error).message });
    } finally {
      running = false;
    }
  });
  log.info('worker started (every 60s)');
}

export function stopWorker(): void {
  task?.stop();
  task = null;
}
