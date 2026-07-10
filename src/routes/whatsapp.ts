import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { log } from '../logger.js';
import { verifyMetaSignature } from '../lib/crypto.js';
import { parseInboundMessages } from '../whatsapp/parse.js';
import { processInbound } from '../services/inbound.js';

interface VerifyQuery {
  'hub.mode'?: string;
  'hub.verify_token'?: string;
  'hub.challenge'?: string;
}

export async function registerWhatsappRoutes(app: FastifyInstance): Promise<void> {
  // ─── GET: webhook verification handshake (§6.1) ─────────────────────────────
  app.get<{ Querystring: VerifyQuery }>('/webhook/whatsapp', async (req, reply) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
      log.info('whatsapp webhook verified');
      return reply.code(200).type('text/plain').send(challenge ?? '');
    }
    log.warn('whatsapp webhook verification failed', { mode });
    return reply.code(403).send('Forbidden');
  });

  // ─── POST: inbound events (§6.1) ────────────────────────────────────────────
  app.post('/webhook/whatsapp', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    // Step 1 — signature verification. Reject anything unsigned/tampered.
    if (!verifyMetaSignature(rawBody, signature, config.whatsapp.appSecret)) {
      log.warn('whatsapp webhook bad signature');
      return reply.code(401).send('invalid signature');
    }

    // Respond 200 fast; do the heavy lifting off the request path so Meta never
    // retries/times out (§6.1).
    reply.code(200).send('EVENT_RECEIVED');

    const messages = parseInboundMessages(req.body);
    for (const parsed of messages) {
      setImmediate(() => {
        processInbound(parsed).catch((err) => {
          log.error('processInbound failed', {
            waMessageId: parsed.waMessageId,
            error: (err as Error).message,
          });
        });
      });
    }
  });
}
