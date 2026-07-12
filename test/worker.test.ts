import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSendAction } from '../src/worker/worker.js';
import type { Followup } from '../src/types.js';

function fu(partial: Partial<Followup>): Followup {
  return {
    id: 'f1',
    lead_id: 'l1',
    send_at: new Date().toISOString(),
    step: 1,
    channel: 'FREEFORM',
    template_name: null,
    body: null,
    bubbles: null,
    status: 'PENDING',
    created_at: new Date().toISOString(),
    ...partial,
  };
}

test('freeform + window open -> sends the step bubbles', () => {
  const a = resolveSendAction(fu({ step: 1, channel: 'FREEFORM' }), true);
  assert.equal(a.kind, 'freeform');
  assert.ok(a.bubbles && a.bubbles.length > 0 && a.bubbles[0]!.body);
});

test('freeform with multiple stored bubbles -> sends them all', () => {
  const a = resolveSendAction(
    fu({ step: 1, channel: 'FREEFORM', bubbles: [{ body: 'one' }, { body: 'two' }, { imageUrl: 'http://x/img.jpg' }] }),
    true,
  );
  assert.equal(a.kind, 'freeform');
  assert.equal(a.bubbles!.length, 3);
});

test('freeform step 1 + window closed + no fallback -> skip', () => {
  const a = resolveSendAction(fu({ step: 1, channel: 'FREEFORM' }), false);
  assert.equal(a.kind, 'skip');
});

test('template channel -> sends the template', () => {
  const a = resolveSendAction(fu({ step: 4, channel: 'TEMPLATE', template_name: 're_engage_still_interested' }), false);
  assert.equal(a.kind, 'template');
  assert.equal(a.templateName, 're_engage_still_interested');
});

test('template channel with missing name -> skip', () => {
  const a = resolveSendAction(fu({ step: 99, channel: 'TEMPLATE', template_name: null }), false);
  assert.equal(a.kind, 'skip');
});
