import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rampCap, applyQualityThrottle } from '../src/services/quality.js';

test('warm-up ramp increases monotonically over time', () => {
  const days = [0, 1, 2, 5, 8, 12, 16, 21, 40];
  const caps = days.map(rampCap);
  for (let i = 1; i < caps.length; i++) {
    assert.ok(caps[i]! >= caps[i - 1]!, `cap should not decrease at day ${days[i]}`);
  }
  assert.equal(rampCap(0), 250);
  assert.equal(rampCap(40), 100_000);
});

test('quality throttle scales down as opt-out rate climbs', () => {
  assert.equal(applyQualityThrottle(1000, 0.0), 1000);
  assert.equal(applyQualityThrottle(1000, 0.04), 500);
  assert.equal(applyQualityThrottle(1000, 0.08), 250);
  assert.equal(applyQualityThrottle(1000, 0.15), 0); // pause
});
