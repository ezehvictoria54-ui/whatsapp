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
    status: 'PENDING',
    created_at: new Date().toISOString(),
    ...partial,
  };
}

test('freeform + window open -> sends the step body', () => {
  const a = resolveSendAction(fu({ step: 1, channel: 'FREEFORM' }), true);
  assert.equal(a.kind, 'freeform');
  assert.ok(a.body && a.body.length > 0);
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
