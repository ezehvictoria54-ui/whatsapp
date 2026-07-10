import type { EntryPoint } from '../types.js';

const HOUR = 60 * 60 * 1000;
export const SERVICE_WINDOW_MS = 24 * HOUR; // standard 24h service window
export const AD_WINDOW_MS = 72 * HOUR; // 72h click-to-WhatsApp ad window

/**
 * Compute the messaging window expiry from the moment of an inbound message.
 * Ad-initiated conversations get the 72h free-form window; everything else 24h.
 */
export function computeWindowExpiry(entryPoint: EntryPoint, from: Date = new Date()): Date {
  const ms = entryPoint === 'ad' ? AD_WINDOW_MS : SERVICE_WINDOW_MS;
  return new Date(from.getTime() + ms);
}

/** True if `at` is still within the lead's service window. */
export function isWindowOpen(windowExpiresAt: string | Date | null, at: Date = new Date()): boolean {
  if (!windowExpiresAt) return false;
  const expiry = typeof windowExpiresAt === 'string' ? new Date(windowExpiresAt) : windowExpiresAt;
  return at.getTime() < expiry.getTime();
}
