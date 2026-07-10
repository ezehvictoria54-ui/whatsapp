import { query, type Queryable } from '../db/pool.js';
import { sendText, sendTemplate } from '../whatsapp/client.js';
import { logMessage } from './messages.js';
import { log } from '../logger.js';

type Db = Queryable;

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
