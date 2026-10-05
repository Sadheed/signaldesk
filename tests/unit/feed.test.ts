import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Activity } from '../../server/domain/types.ts';
import { mergeActivities } from '../../client/src/feed.ts';
const activity = (id: string, sequence: string, read = false): Activity => ({
  id,
  sequence,
  read,
  workspaceId: 'w',
  title: 'Update',
  body: 'Details',
  kind: 'incident',
  actorName: 'Ada',
  createdAt: '2026-01-01T00:00:00Z',
});
test('replay deduplicates by ID, preserves read state, and orders bigint cursors', () => {
  const existing = activity('one', '9007199254740992', true);
  const result = mergeActivities(
    [existing],
    [activity('one', '9007199254740992'), activity('two', '9007199254740993')],
  );
  assert.deepEqual(
    result.map((event) => event.id),
    ['two', 'one'],
  );
  assert.equal(result[1]!.read, true);
});
test('frontend history is bounded while retaining newest events', () => {
  const events = Array.from({ length: 10 }, (_, index) =>
    activity(String(index), String(index + 1)),
  );
  assert.deepEqual(
    mergeActivities([], events, 3).map((event) => event.sequence),
    ['10', '9', '8'],
  );
});
