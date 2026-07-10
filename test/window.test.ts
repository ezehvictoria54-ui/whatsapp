import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWindowExpiry, isWindowOpen, AD_WINDOW_MS, SERVICE_WINDOW_MS } from '../src/lib/window.js';

test('ad-initiated leads get a 72h window', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  const expiry = computeWindowExpiry('ad', from);
  assert.equal(expiry.getTime() - from.getTime(), AD_WINDOW_MS);
});

test('organic leads get a 24h window', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  const expiry = computeWindowExpiry('organic', from);
  assert.equal(expiry.getTime() - from.getTime(), SERVICE_WINDOW_MS);
});

test('isWindowOpen respects expiry', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  assert.equal(isWindowOpen('2026-01-01T13:00:00Z', now), true);
  assert.equal(isWindowOpen('2026-01-01T11:00:00Z', now), false);
  assert.equal(isWindowOpen(null, now), false);
});
