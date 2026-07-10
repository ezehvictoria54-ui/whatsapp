import type { ParsedInbound } from '../types.js';

/**
 * Extract inbound messages from a WhatsApp Cloud API webhook payload.
 *
 * A single payload can carry multiple entries/changes/messages. We return one
 * ParsedInbound per user message. Status callbacks (delivered/read) carry a
 * `statuses` array instead of `messages` and are ignored here.
 */
export function parseInboundMessages(payload: unknown): ParsedInbound[] {
  const out: ParsedInbound[] = [];
  const root = payload as { entry?: unknown[] };
  if (!root || !Array.isArray(root.entry)) return out;

  for (const entry of root.entry) {
    const changes = (entry as { changes?: unknown[] }).changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> }).value;
      if (!value) continue;

      const messages = value.messages;
      if (!Array.isArray(messages)) continue;

      // profile name lives in the parallel contacts[] array, keyed by wa_id.
      const contacts = Array.isArray(value.contacts) ? (value.contacts as unknown[]) : [];
      const nameByWaId = new Map<string, string>();
      for (const c of contacts) {
        const contact = c as { wa_id?: string; profile?: { name?: string } };
        if (contact.wa_id && contact.profile?.name) {
          nameByWaId.set(contact.wa_id, contact.profile.name);
        }
      }

      for (const m of messages) {
        const msg = m as {
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          button?: { text?: string };
          interactive?: {
            button_reply?: { title?: string };
            list_reply?: { title?: string };
          };
          referral?: {
            source_id?: string;
            source_type?: string;
            ctwa_clid?: string;
          };
        };

        if (!msg.from || !msg.id) continue;

        const referral = msg.referral;
        const isAd = Boolean(referral);
        const source =
          referral?.source_id ?? referral?.ctwa_clid ?? (isAd ? 'ad' : null);

        out.push({
          waId: msg.from,
          profileName: nameByWaId.get(msg.from) ?? null,
          waMessageId: msg.id,
          body: extractBody(msg),
          type: msg.type ?? 'unknown',
          isAd,
          source,
          timestamp: msg.timestamp ? Number.parseInt(msg.timestamp, 10) : null,
        });
      }
    }
  }

  return out;
}

function extractBody(msg: {
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}): string {
  if (msg.text?.body) return msg.text.body;
  if (msg.button?.text) return msg.button.text;
  if (msg.interactive?.button_reply?.title) return msg.interactive.button_reply.title;
  if (msg.interactive?.list_reply?.title) return msg.interactive.list_reply.title;
  return '';
}
