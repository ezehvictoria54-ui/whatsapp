import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, canonicalSequence } from '../src/services/offers.js';
import { renderMessage, naira } from '../src/lib/render.js';

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

test('renderMessage fills placeholders', () => {
  const out = renderMessage('Hi {name}, the {offer} is {price}.', {
    name: 'Ada Obi', offerName: 'Glow Set', priceKobo: 1_250_000,
  });
  assert.equal(out, 'Hi Ada, the Glow Set is ₦12,500.');
  assert.equal(naira(1_800_000), '₦18,000');
});
