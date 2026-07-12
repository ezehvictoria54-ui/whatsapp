import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, canonicalSequence, stepBubbles } from '../src/services/offers.js';
import { renderMessage, naira } from '../src/lib/render.js';
import type { OfferSequenceStep } from '../src/types.js';

test('normalize lowercases and strips non-alphanumerics', () => {
  assert.equal(normalize('OFFER1'), 'offer1');
  assert.equal(normalize('offer 1'), 'offer1');
  assert.equal(normalize('start offer1!'), 'startoffer1');
  assert.equal(normalize('  Glow-Set  '), 'glowset');
});

test('keyword matching semantics (normalized includes)', () => {
  // This mirrors how matchOfferByKeyword compares a normalized body to a keyword.
  const match = (body: string, keyword: string) => normalize(body).includes(normalize(keyword));
  assert.equal(match('OFFER1', 'offer1'), true);
  assert.equal(match('offer 1', 'offer1'), true);
  assert.equal(match('start offer1 please', 'offer1'), true);
  assert.equal(match('I want glow set', 'glow'), true);
  assert.equal(match('just browsing', 'glow'), false);
});

test('longer keywords are more specific (offer10 vs offer1)', () => {
  const body = normalize('send me offer10');
  assert.equal(body.includes('offer10'), true);
  // offer1 is also a substring, which is why the service sorts by length desc
  assert.equal(body.includes('offer1'), true);
});

test('canonical sequence has the 7 steps with offsets/channels', () => {
  const seq = canonicalSequence();
  assert.equal(seq.length, 7);
  assert.deepEqual(seq.map((s) => s.step), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(seq[0]!.channel, 'FREEFORM');
  assert.equal(seq[6]!.channel, 'TEMPLATE');
});

test('multi-word keyword matches with or without a space', () => {
  const match = (body: string, keyword: string) => normalize(body).includes(normalize(keyword));
  assert.equal(match('flat tummy', 'flattummy'), true);
  assert.equal(match('flattummy', 'flattummy'), true);
  assert.equal(match('FLAT TUMMY!', 'flattummy'), true);
  assert.equal(match('I am interested please', 'interested'), true);
  assert.equal(match('nothing here', 'flattummy'), false);
});

test('stepBubbles: explicit bubbles win, freeformBody is a one-bubble fallback, empties dropped', () => {
  const multi: OfferSequenceStep = {
    step: 0, offsetMs: 0, channel: 'FREEFORM', purpose: 'x',
    bubbles: [{ body: 'a' }, { imageUrl: 'http://img' }, { body: '' }, { body: '  ', imageUrl: '' }],
  };
  assert.equal(stepBubbles(multi).length, 2); // 'a' + image bubble; blanks dropped

  const legacy: OfferSequenceStep = { step: 1, offsetMs: 0, channel: 'FREEFORM', purpose: 'x', freeformBody: 'hello' };
  assert.deepEqual(stepBubbles(legacy), [{ body: 'hello' }]);

  const template: OfferSequenceStep = { step: 4, offsetMs: 0, channel: 'TEMPLATE', purpose: 'x', templateName: 't' };
  assert.equal(stepBubbles(template).length, 0);
});

test('renderMessage fills placeholders', () => {
  const out = renderMessage('Hi {name}, the {offer} is {price}.', {
    name: 'Ada Obi', offerName: 'Glow Set', priceKobo: 1_250_000,
  });
  assert.equal(out, 'Hi Ada, the Glow Set is ₦12,500.');
  assert.equal(naira(1_800_000), '₦18,000');
});
