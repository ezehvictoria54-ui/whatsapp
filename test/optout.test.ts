import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOptOut } from '../src/services/optout.js';

test('exact keywords opt out (case/space insensitive)', () => {
  for (const s of ['STOP', 'stop', '  Stop  ', 'UNSUBSCRIBE', 'cancel', 'QUIT']) {
    assert.equal(isOptOut(s), true, `${s} should be opt-out`);
  }
});

test('non-exact messages do not opt out', () => {
  for (const s of ['please stop helping me', 'I want to stop by', 'stop it now', 'yes', '']) {
    assert.equal(isOptOut(s), false, `${s} should NOT be opt-out`);
  }
});
