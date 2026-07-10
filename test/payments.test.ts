import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bankTransferCopy, receiptCopy } from '../src/services/payments.js';
import { ensureOptOut } from '../src/ai/reply.js';

test('bank transfer copy includes amount, account details and expiry', () => {
  const copy = bankTransferCopy(
    { reference: 'ref1', accountNumber: '0001234567', accountName: 'Titan / Order', bankName: 'Titan Bank', expiresAt: null },
    500000, // ₦5,000 in kobo
    3,
  );
  assert.match(copy, /₦5,000/);
  assert.match(copy, /0001234567/);
  assert.match(copy, /Titan Bank/);
  assert.match(copy, /Titan \/ Order/);
  assert.match(copy, /3 hours/);
});

test('receipt copy confirms payment', () => {
  assert.match(receiptCopy(), /Payment received/i);
});

test('ensureOptOut appends the opt-out line at most once', () => {
  const withLine = ensureOptOut('Hello there. Reply STOP to opt out anytime.');
  assert.equal((withLine.match(/reply stop/gi) ?? []).length, 1);
  const added = ensureOptOut('Hello there.');
  assert.match(added, /Reply STOP to opt out anytime\./);
});
