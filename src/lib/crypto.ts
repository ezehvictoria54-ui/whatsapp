import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time compare of two hex-or-ascii signature strings. Returns false on
 * length mismatch rather than throwing so callers can treat it as "invalid".
 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verify Meta's `X-Hub-Signature-256` header: HMAC-SHA256 of the raw request
 * body keyed with the app secret, formatted as `sha256=<hex>`.
 */
export function verifyMetaSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header) return false;
  const expected =
    'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(header, expected);
}

/**
 * Verify Paystack's `x-paystack-signature` header: HMAC-SHA512 of the raw body
 * keyed with the secret key, as a bare hex string.
 */
export function verifyPaystackSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secretKey: string,
): boolean {
  if (!header) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest('hex');
  return safeEqual(header, expected);
}
