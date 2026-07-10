import { config } from '../config.js';
import { log } from '../logger.js';

export interface SendResult {
  waMessageId: string | null;
  dryRun: boolean;
}

interface GraphMessageResponse {
  messages?: Array<{ id: string }>;
  error?: { message: string; code: number; type: string };
}

function graphUrl(): string {
  return `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;
}

async function postToGraph(body: Record<string, unknown>): Promise<SendResult> {
  if (config.dryRun) {
    log.info('whatsapp send (DRY_RUN)', { body });
    return { waMessageId: `dryrun-${Date.now()}`, dryRun: true };
  }

  const res = await fetch(graphUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as GraphMessageResponse;
  if (!res.ok || json.error) {
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    log.error('whatsapp send failed', { status: res.status, error: msg });
    throw new Error(`WhatsApp send failed: ${msg}`);
  }

  return { waMessageId: json.messages?.[0]?.id ?? null, dryRun: false };
}

/** Send a free-form text message (only valid inside the 24h/72h window). */
export async function sendText(waId: string, body: string): Promise<SendResult> {
  return postToGraph({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: waId,
    type: 'text',
    text: { preview_url: false, body },
  });
}

export interface TemplateComponentParam {
  type: 'text';
  text: string;
}

/**
 * Send a pre-approved template message (required outside the window).
 * `bodyParams` fill the template's {{1}}, {{2}}… placeholders in order.
 */
export async function sendTemplate(
  waId: string,
  templateName: string,
  languageCode = 'en',
  bodyParams: string[] = [],
): Promise<SendResult> {
  const components =
    bodyParams.length > 0
      ? [
          {
            type: 'body',
            parameters: bodyParams.map<TemplateComponentParam>((text) => ({ type: 'text', text })),
          },
        ]
      : undefined;

  return postToGraph({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: waId,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components ? { components } : {}),
    },
  });
}

/** Mark an inbound message as read (best-effort; failures are swallowed). */
export async function markRead(waMessageId: string): Promise<void> {
  try {
    if (config.dryRun) return;
    await fetch(graphUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: waMessageId,
      }),
    });
  } catch (err) {
    log.warn('markRead failed', { error: (err as Error).message });
  }
}
