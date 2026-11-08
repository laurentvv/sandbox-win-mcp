import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateIdleMinutes, drag } from '../../src/core.js';

test('idleMinutes: per-call value, default and bounds', () => {
  assert.equal(validateIdleMinutes(7), 7);
  assert.equal(validateIdleMinutes(1440), 1440);
  assert.equal(validateIdleMinutes(undefined), 30); // default from SANDBOX_MCP_IDLE_MINUTES/30
  assert.equal(validateIdleMinutes('12'), 12); // CLI strings coerce
});

test('idleMinutes: rejects junk with a clear error', () => {
  for (const bad of [0, -5, 1441, 4.5, 'abc', 'NaN', {}, true]) {
    assert.throws(() => validateIdleMinutes(bad), /idleMinutes must be an integer between 1 and 1440/, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('drag validates coordinates before touching any sandbox', async () => {
  await assert.rejects(() => drag({ x1: 0, y1: 0, x2: 10, y2: 10, coordinates: 'pixels' }), /coordinates must be screen or screenshot/);
  await assert.rejects(() => drag({ x1: 'a', y1: 0, x2: 10, y2: 10 }), /x1, y1, x2 and y2 must be finite/);
  await assert.rejects(() => drag({ x1: 0, y1: 0, x2: 10, y2: 10, durationMs: 99999 }), /durationMs must be between 0 and 10000/);
});
