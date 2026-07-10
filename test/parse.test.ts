import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInboundMessages } from '../src/whatsapp/parse.js';

function payload(message: Record<string, unknown>, contacts: unknown[] = []) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      { id: 'WABA', changes: [{ field: 'messages', value: { contacts, messages: [message] } }] },
    ],
  };
}

test('parses a plain text message as organic', () => {
  const p = payload(
    { from: '2348012345678', id: 'wamid.1', timestamp: '1700000000', type: 'text', text: { body: 'hi' } },
    [{ wa_id: '2348012345678', profile: { name: 'Ada' } }],
  );
  const [m] = parseInboundMessages(p);
  assert.equal(m!.waId, '2348012345678');
  assert.equal(m!.profileName, 'Ada');
  assert.equal(m!.body, 'hi');
  assert.equal(m!.isAd, false);
  assert.equal(m!.source, null);
});

test('detects an ad-initiated message via referral', () => {
  const p = payload({
    from: '2348011111111',
    id: 'wamid.2',
    type: 'text',
    text: { body: 'I saw your ad' },
    referral: { source_id: 'AD_123', source_type: 'ad', ctwa_clid: 'clid_x' },
  });
  const [m] = parseInboundMessages(p);
  assert.equal(m!.isAd, true);
  assert.equal(m!.source, 'AD_123');
});

test('extracts button/interactive titles', () => {
  const p = payload({
    from: '234',
    id: 'wamid.3',
    type: 'interactive',
    interactive: { button_reply: { title: 'Buy now' } },
  });
  const [m] = parseInboundMessages(p);
  assert.equal(m!.body, 'Buy now');
});

test('ignores status callbacks (no messages array)', () => {
  const p = {
    entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'delivered' }] } }] }],
  };
  assert.equal(parseInboundMessages(p).length, 0);
});

test('handles malformed payloads gracefully', () => {
  assert.deepEqual(parseInboundMessages(null), []);
  assert.deepEqual(parseInboundMessages({}), []);
  assert.deepEqual(parseInboundMessages({ entry: 'nope' }), []);
});
