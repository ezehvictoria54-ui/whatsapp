import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';
import { registerWhatsappRoutes } from './routes/whatsapp.js';
import { registerPaystackRoutes } from './routes/paystack.js';
import { registerApiRoutes } from './routes/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  // Keep the raw body around so webhook HMAC signatures can be verified against
  // the exact bytes Meta / Paystack signed, while still exposing parsed JSON.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      try {
        const parsed = (body as Buffer).length ? JSON.parse((body as Buffer).toString('utf8')) : {};
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  await registerWhatsappRoutes(app);
  await registerPaystackRoutes(app);
  await registerApiRoutes(app);

  // Serve the read-only dashboard from /public at the site root.
  await app.register(fastifyStatic, {
    root: join(__dirname, '..', 'public'),
    prefix: '/',
  });

  app.setErrorHandler((err, _req, reply) => {
    log.error('request error', { error: err.message });
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  return app;
}
