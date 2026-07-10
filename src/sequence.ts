import type { Channel } from './types.js';

/**
 * The 7-day follow-up sequence from §7 of the spec.
 *
 * Design principle: front-load value inside the free 72h ad window (steps 0–3,
 * free-form), taper hard after (steps 4–6, pre-approved templates, billed).
 *
 * `offsetMs` is measured from first contact. `channel` is the *intended*
 * channel; the scheduler re-evaluates FREEFORM vs TEMPLATE against the lead's
 * actual window at insert time, and the worker re-checks again at send time.
 */
export interface SequenceStep {
  step: number;
  offsetMs: number;
  channel: Channel;
  purpose: string;
  /** Free-form body used when sending inside the window. */
  freeformBody?: string;
  /**
   * Template name to use when outside the window. Required for TEMPLATE steps;
   * optional fallback for FREEFORM steps whose window has since closed.
   */
  templateName?: string;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const SEQUENCE: readonly SequenceStep[] = [
  {
    step: 0,
    offsetMs: 0,
    channel: 'FREEFORM',
    purpose: 'Welcome + pitch/qualify + CTA',
    // Step 0 is delivered by the instant-reply path, not the worker. Kept here
    // for completeness so the sequence table is the single source of truth.
    freeformBody:
      "Thanks for reaching out! 🙌 Here's how we can help — tell me a bit about what you need and I'll get you sorted. Reply STOP to opt out anytime.",
  },
  {
    step: 1,
    offsetMs: 3 * HOUR,
    channel: 'FREEFORM',
    purpose: 'Answer likely objection / social proof',
    freeformBody:
      "Quick note while it's fresh: most customers ask about pricing and delivery. Hundreds of happy buyers so far — happy to answer any question you have. Reply STOP to opt out.",
  },
  {
    step: 2,
    offsetMs: 24 * HOUR,
    channel: 'FREEFORM',
    purpose: 'Case study or testimonial + payment link',
    freeformBody:
      'Here\'s a recent result from a customer just like you 👇 When you\'re ready, I can set up your order in under a minute. Just say the word. Reply STOP to opt out.',
  },
  {
    step: 3,
    offsetMs: 48 * HOUR,
    channel: 'FREEFORM',
    purpose: 'Scarcity / limited offer nudge',
    freeformBody:
      "Heads up — this offer is limited and spots are filling. If you'd like to lock it in, reply YES and I'll send your secure payment details. Reply STOP to opt out.",
  },
  {
    step: 4,
    // ~72h+, ad window closed → marketing template.
    offsetMs: 3 * DAY,
    channel: 'TEMPLATE',
    purpose: 'Re-engage: "still interested?" + link',
    templateName: 're_engage_still_interested',
  },
  {
    step: 5,
    offsetMs: 5 * DAY,
    channel: 'TEMPLATE',
    purpose: 'Final value + last-chance offer',
    templateName: 'final_value_last_chance',
  },
  {
    step: 6,
    offsetMs: 7 * DAY,
    channel: 'TEMPLATE',
    purpose: 'Close-out / soft goodbye',
    templateName: 'closeout_soft_goodbye',
  },
] as const;

/** Steps the worker is responsible for (everything after the instant reply). */
export const WORKER_STEPS = SEQUENCE.filter((s) => s.step >= 1);

export function stepByNumber(step: number): SequenceStep | undefined {
  return SEQUENCE.find((s) => s.step === step);
}
