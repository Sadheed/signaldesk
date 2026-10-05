import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { writeFrame } from '../../server/realtime/writer.ts';

test('SSE writer waits for drain before the producer may send another frame', async () => {
  let finish: (() => void) | undefined;
  const writable = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      finish = callback;
    },
  });
  let resolved = false;
  const pending = writeFrame(writable, 'event frame', 500, new AbortController().signal).then(
    () => {
      resolved = true;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(writable.writableLength, 'event frame'.length);
  finish!();
  await pending;
  assert.equal(resolved, true);
  assert.equal(writable.listenerCount('drain'), 0);
  writable.destroy();
});
test('slow consumers time out and listeners are removed', async () => {
  const writable = new Writable({ highWaterMark: 1, write() {} });
  await assert.rejects(
    writeFrame(writable, 'frame', 20, new AbortController().signal),
    /Slow consumer/,
  );
  assert.equal(writable.listenerCount('drain'), 0);
  assert.equal(writable.listenerCount('error'), 0);
  writable.destroy();
});
test('disconnect aborts a blocked write immediately', async () => {
  const writable = new Writable({ highWaterMark: 1, write() {} });
  const controller = new AbortController();
  const pending = writeFrame(writable, 'frame', 1000, controller.signal);
  controller.abort();
  await assert.rejects(pending, /Connection closed/);
  writable.destroy();
});
