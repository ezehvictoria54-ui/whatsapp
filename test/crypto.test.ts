import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature, verifyPaystackSignature } from '../src/lib/crypto.js';

test('verifyMetaSignature accepts a correct sha256 signature', () => {
  const secret = 'app-secret';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyMetaSignature(body, sig, secret), true);
});

test('verifyMetaSignature rejects a tampered body', () => {
  const secret = 'app-secret';
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyMetaSignature(Buffer.from('{"a":2}'), sig, secret), false);
});

test('verifyMetaSignature rejects missing/garbage header', () => {
  const secret = 's';
  const body = Buffer.from('x');
  assert.equal(verifyMetaSignature(body, undefined, secret), false);
  assert.equal(verifyMetaSignature(body, 'sha256=deadbeef', secret), false);
});

test('verifyPaystackSignature accepts a correct sha512 signature', () => {
  const secret = 'sk_test_123';
  const body = Buffer.from(JSON.stringify({ event: 'charge.success' }));
  const sig = createHmac('sha512', secret).update(body).digest('hex');
  assert.equal(verifyPaystackSignature(body, sig, secret), true);
});

test('verifyPaystackSignature rejects wrong secret', () => {
  const body = Buffer.from('{}');
  const sig = createHmac('sha512', 'right').update(body).digest('hex');
  assert.equal(verifyPaystackSignature(body, sig, 'wrong'), false);
});
