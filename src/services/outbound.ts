import { query, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { sendText, sendTemplate, sendImage } from '../whatsapp/client.js';
import { logMessage } from './messages.js';
import { log } from '../logger.js';
import type { Bubble } from '../types.js';

type Db = Queryable;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Gap between consecutive bubbles in a step, so they arrive like a person typing. */
const BUBBLE_GAP_MS = config.dryRun ? 0 : 2500;

/**
 * Send a free-form text to a lead and log it as an OUT message. Only valid
 * inside the 24h/72h window — callers are responsible for that gate.
 */
export async function sendFreeformToLead(
  leadId: string,
  waId: string,
  body: string,
  db: Db = { query },
): Promise<void> {
  const result = await sendText(waId, body);
  await logMessage(
    { leadId, direction: 'OUT', body, type: 'text', waMessageId: result.waMessageId },
    db,
  );
  log.info('sent freeform', { leadId, waId, dryRun: result.dryRun });
}

/**
 * Send a step's bubbles (§ multiple bubbles per step): each bubble is a separate
 * WhatsApp message — an image (with the body as caption) if it has an image,
 * else a text — delivered a short gap apart, and each logged as its own OUT
 * message. When image sending isn't live (DRY_RUN), the image URL is still
 * stored on the logged message so the dashboard can display it.
 *
 * Returns how many bubbles were sent.
 */
export async function sendBubblesToLead(
  leadId: string,
  waId: string,
  bubbles: Bubble[],
  db: Db = { query },
): Promise<number> {
  let sent = 0;
  for (const b of bubbles) {
    const body = (b.body ?? '').trim();
    const imageUrl = (b.imageUrl ?? '').trim() || null;
    if (!body && !imageUrl) continue;
    if (sent > 0 && BUBBLE_GAP_MS > 0) await sleep(BUBBLE_GAP_MS);

    const result = imageUrl
      ? await sendImage(waId, imageUrl, body || undefined)
      : await sendText(waId, body);
    await logMessage(
      {
        leadId,
        direction: 'OUT',
        body: body || null,
        type: imageUrl ? 'image' : 'text',
        waMessageId: result.waMessageId,
        imageUrl,
      },
      db,
    );
    sent++;
  }
  log.info('sent bubbles', { leadId, waId, count: sent });
  return sent;
}

/**
 * Send a pre-approved template to a lead and log it as an OUT message. `preview`
 * is a human-readable rendering stored in the thread log (the real body is
 * assembled by Meta from the template + params).
 */
export async function sendTemplateToLead(
  leadId: string,
  waId: string,
  templateName: string,
  params: string[],
  preview: string,
  db: Db = { query },
): Promise<void> {
  const result = await sendTemplate(waId, templateName, 'en', params);
  await logMessage(
    {
      leadId,
      direction: 'OUT',
      body: preview || `[template:${templateName}]`,
      type: 'template',
      waMessageId: result.waMessageId,
    },
    db,
  );
  log.info('sent template', { leadId, waId, templateName, dryRun: result.dryRun });
}
