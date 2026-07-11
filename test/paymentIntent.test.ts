import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPaymentClaim } from '../src/services/paymentIntent.js';

test('detects common payment-claim phrases', () => {
  for (const s of [
    'paid', 'I paid', "I've paid", 'ive paid', 'i have paid', 'paid o',
    'done', 'sent', 'I sent it', 'transferred', 'payment made', 'made payment',
    'Done!', 'PAID O', 'i just paid now',
  ]) {
    assert.equal(isPaymentClaim(s), true, `"${s}" should be a claim`);
  }
});

test('does not misfire on non-claims', () => {
  for (const s of [
    'how much is it', 'is it available', 'unpaid balance?', 'i want to pay later',
    'what payment options do you have', '', 'undone', 'paidx',
  ]) {
    assert.equal(isPaymentClaim(s), false, `"${s}" should NOT be a claim`);
  }
});

test('phrase list is editable via the argument', () => {
  assert.equal(isPaymentClaim('mo ti san', ['mo ti san']), true);
  assert.equal(isPaymentClaim('paid', ['mo ti san']), false);
});
