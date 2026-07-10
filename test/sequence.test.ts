import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEQUENCE, WORKER_STEPS, stepByNumber } from '../src/sequence.js';
import { resolveChannel } from '../src/services/followups.js';

test('sequence has 7 steps (0..6) and worker owns 1..6', () => {
  assert.equal(SEQUENCE.length, 7);
  assert.deepEqual(SEQUENCE.map((s) => s.step), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(WORKER_STEPS.map((s) => s.step), [1, 2, 3, 4, 5, 6]);
});

test('steps 0-3 are free-form, 4-6 are templates with names', () => {
  for (const s of SEQUENCE) {
    if (s.step <= 3) assert.equal(s.channel, 'FREEFORM');
    else {
      assert.equal(s.channel, 'TEMPLATE');
      assert.ok(s.templateName, `step ${s.step} needs a template name`);
    }
  }
});

test('resolveChannel: free-form step inside window stays FREEFORM', () => {
  const step = stepByNumber(1)!;
  const sendAt = new Date('2026-01-01T03:00:00Z');
  const windowExpiry = new Date('2026-01-04T00:00:00Z'); // 72h ad window
  const r = resolveChannel(step, sendAt, windowExpiry);
  assert.equal(r.channel, 'FREEFORM');
  assert.equal(r.templateName, null);
});

test('resolveChannel: free-form step past window with no fallback -> FREEFORM (worker will skip)', () => {
  const step = stepByNumber(2)!; // +24h, no template
  const sendAt = new Date('2026-01-02T00:00:00Z');
  const windowExpiry = new Date('2026-01-01T24:00:00Z'); // 24h organic window (expired before send)
  const r = resolveChannel(step, sendAt, new Date('2026-01-01T23:00:00Z'));
  assert.equal(r.channel, 'FREEFORM');
  assert.equal(r.templateName, null);
  void windowExpiry;
  void sendAt;
});

test('resolveChannel: template step always resolves to its template', () => {
  const step = stepByNumber(4)!;
  const r = resolveChannel(step, new Date(), new Date());
  assert.equal(r.channel, 'TEMPLATE');
  assert.equal(r.templateName, step.templateName);
});
