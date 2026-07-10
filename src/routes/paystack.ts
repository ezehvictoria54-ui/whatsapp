import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { log } from '../logger.js';
import { verifyPaystackSignature } from '../lib/crypto.js';
import { handleChargeSuccess } from '../services/payments.js';

interface PaystackEvent {
  event?: string;
  data?: {
    reference?: string;
    amount?: number;
    metadata?: { wa_id?: string } | string;
    customer?: { phone?: string; email?: string };
  };
}

function extractWaId(data: PaystackEvent['data']): string | null {
  const meta = data?.metadata;
  if (meta && typeof meta === 'object' && meta.wa_id) return meta.wa_id;
  // Paystack sometimes serialises metadata as a JSON string.
  if (typeof meta === 'string') {
    try {
      const parsed = JSON.parse(meta) as { wa_id?: string };
      if (parsed.wa_id) return parsed.wa_id;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function registerPaystackRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhook/paystack', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
    const signature = req.headers['x-paystack-signature'] as string | undefined;

    // Step 1 — HMAC-SHA512 signature verification (§6.3b).
    if (!verifyPaystackSignature(rawBody, signature, config.paystack.secretKey)) {
      log.warn('paystack webhook bad signature');
      return reply.code(401).send('invalid signature');
    }

    const event = req.body as PaystackEvent;

    // Step 2 — handle charge.success only (transfer, USSD, and card alike).
    if (event.event !== 'charge.success' || !event.data?.reference) {
      return reply.code(200).send('ignored');
    }

    // Respond fast; process off the request path.
    reply.code(200).send('ok');

    const payload = {
      reference: event.data.reference,
      waId: extractWaId(event.data),
      amountKobo: typeof event.data.amount === 'number' ? event.data.amount : null,
      provider: 'paystack',
    };
    setImmediate(() => {
      handleChargeSuccess(payload).catch((err) => {
        log.error('handleChargeSuccess failed', {
          reference: payload.reference,
          error: (err as Error).message,
        });
      });
    });
  });
}
