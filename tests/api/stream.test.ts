import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/http/app.ts';
import { readConfig } from '../../server/config.ts';
import { SseHub } from '../../server/realtime/hub.ts';
import { newToken, hashToken } from '../../server/security.ts';
import { MemoryBus, MemoryStore } from '../support/memory.ts';

async function fixture(maxPerUser = 3) {
  const store = new MemoryStore();
  const bus = new MemoryBus();
  const logger = { info() {}, warn() {}, error() {} };
  const config = readConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused',
    REDIS_URL: 'redis://unused',
    SSE_RECONCILE_MS: '100',
    SSE_MAX_PER_USER: String(maxPerUser),
  });
  const actor = await store.register(
    { name: 'Ada', email: 'ada@example.test', workspaceName: 'Test' },
    'unused',
  );
  const token = newToken();
  await store.createSession(hashToken(token), actor.id, new Date(Date.now() + 60000));
  const hub = new SseHub(store, bus, config, logger);
  const server = createApp({ store, bus, config, logger, stream: hub }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    bus,
    actor,
    token,
    hub,
    stream: (after = '0', last?: string) =>
      fetch(`${base}/api/events/stream?after=${after}`, {
        headers: { Cookie: `sd_session=${token}`, ...(last ? { 'Last-Event-ID': last } : {}) },
        signal: AbortSignal.timeout(3000),
      }),
    close: async () => {
      hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function nextActivity(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ sequence: string; title: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Stream closed without event');
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop()!;
    for (const block of blocks) {
      const data = block.split('\n').find((line) => line.startsWith('data: '));
      if (data) return JSON.parse(data.slice(6));
    }
  }
}

test('SSE reconnect honors Last-Event-ID over the original query cursor', async () => {
  const f = await fixture();
  try {
    await f.store.createEvent(f.actor, { title: 'First', body: 'One', kind: 'announcement' });
    await f.store.createEvent(f.actor, { title: 'Second', body: 'Two', kind: 'deployment' });
    const response = await f.stream('0', '1');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const reader = response.body!.getReader();
    assert.equal((await nextActivity(reader)).sequence, '2');
    await reader.cancel();
  } finally {
    await f.close();
  }
});
test('reconciliation delivers stored events even when no Redis hint arrives', async () => {
  const f = await fixture();
  try {
    const response = await f.stream();
    const reader = response.body!.getReader();
    await f.store.createEvent(f.actor, {
      title: 'Missed hint',
      body: 'Recovered from database',
      kind: 'incident',
    });
    assert.equal((await nextActivity(reader)).title, 'Missed hint');
    await reader.cancel();
  } finally {
    await f.close();
  }
});
test('connection caps reject extra streams and release slots on disconnect', async () => {
  const f = await fixture(1);
  try {
    const first = await f.stream();
    assert.equal((await f.stream()).status, 429);
    await first.body!.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.hub.size, 0);
    const third = await f.stream();
    assert.equal(third.status, 200);
    await third.body!.cancel();
  } finally {
    await f.close();
  }
});
test('revoking a session closes an already connected stream', async () => {
  const f = await fixture();
  try {
    const response = await f.stream();
    const reader = response.body!.getReader();
    await f.store.revokeSession(hashToken(f.token));
    while (!(await reader.read()).done) {
      /* Drain heartbeat until the auth recheck closes the stream. */
    }
    assert.equal(f.hub.size, 0);
  } finally {
    await f.close();
  }
});
