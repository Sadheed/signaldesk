import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Throttle } from '../../server/http/throttle.ts';
test('authentication throttle limits attempts and resets only after expiry', () => {
  const throttle = new Throttle(2, 1000);
  throttle.check('ip', 0);
  throttle.check('ip', 1);
  assert.throws(() => throttle.check('ip', 2), { status: 429 });
  assert.doesNotThrow(() => throttle.check('different-ip', 2));
  assert.doesNotThrow(() => throttle.check('ip', 1000));
});
