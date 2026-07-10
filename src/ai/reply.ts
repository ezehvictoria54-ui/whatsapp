import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { log } from '../logger.js';

const OPT_OUT_LINE = 'Reply STOP to opt out anytime.';

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!config.ai.enabled || !config.ai.apiKey) return null;
  if (!client) client = new Anthropic({ apiKey: config.ai.apiKey });
  return client;
}

/**
 * Optionally generate an AI qualification/answer for the lead's first message
 * (§6.2). Returns null when AI replies are disabled or the call fails, so the
 * caller falls back to the fixed welcome. Always guarantees the opt-out line is
 * present exactly once.
 */
export async function generateAiReply(
  leadMessage: string,
  leadName: string | null,
): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  try {
    const namePart = leadName ? ` The lead's name is ${leadName}.` : '';
    const response = await c.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 300,
      system:
        config.ai.systemPrompt +
        `${namePart} Keep a warm, human tone. Use one clear call to action. ` +
        'Do not include an opt-out line; it is appended automatically. Keep it under 4 short sentences.',
      messages: [{ role: 'user', content: leadMessage }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!text) return null;
    return ensureOptOut(text);
  } catch (err) {
    log.warn('AI reply failed, falling back to fixed welcome', {
      error: (err as Error).message,
    });
    return null;
  }
}

export function ensureOptOut(text: string): string {
  if (text.toUpperCase().includes('REPLY STOP')) return text;
  return `${text}\n\n${OPT_OUT_LINE}`;
}
