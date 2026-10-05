import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, hashToken, newToken } from '../../server/security.ts';
import { parseCursor, requireAdmin } from '../../server/domain/errors.ts';

test('salted password hashing verifies correct passwords without storing plaintext', async () => {
  const password = 'correct-horse-battery-staple';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('wrong', first), false);
  assert.equal(await verifyPassword(password, 'malformed'), false);
});
test('opaque sessions use unpredictable tokens and stable hashes', () => {
  const token = newToken();
  assert.notEqual(token, newToken());
  assert.equal(token.length, 43);
  assert.equal(hashToken(token).length, 64);
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), token);
});
test('cursors preserve bigint precision and reject malformed/out-of-range input', () => {
  assert.equal(parseCursor('9007199254740993'), '9007199254740993');
  for (const value of ['-1', '01', '1e3', '9223372036854775808', '', ['1'], 1]) assert.throws(() => parseCursor(value));
});
test('members cannot perform admin operations', () => {
  assert.doesNotThrow(() => requireAdmin('admin'));
  assert.throws(() => requireAdmin('member'), { status: 403 });
});
