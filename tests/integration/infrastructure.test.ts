import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PostgresStore } from '../../server/adapters/postgres.ts';
import { RedisBus } from '../../server/adapters/redis.ts';
import { SseHub } from '../../server/realtime/hub.ts';
import { createApp } from '../../server/http/app.ts';
import { readConfig } from '../../server/config.ts';
import { AuthService } from '../../server/services/auth.ts';
import { EventService } from '../../server/services/events.ts';
import type { Actor } from '../../server/domain/types.ts';

// No silent skipping: this suite fails unless actual disposable infrastructure is supplied.
const pgUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
if (!pgUrl || !redisUrl)
  throw new Error('Set TEST_DATABASE_URL and TEST_REDIS_URL to disposable local services.');
const pg = new URL(pgUrl);
const redis = new URL(redisUrl);
if (
  !['localhost', '127.0.0.1'].includes(pg.hostname) ||
  !/test/i.test(pg.pathname) ||
  !['localhost', '127.0.0.1'].includes(redis.hostname)
)
  throw new Error(
    'Integration tests require a local PostgreSQL test database and local Redis. Remote services are refused.',
  );
const logger = { info() {}, warn() {}, error() {} };
const config = readConfig({
  NODE_ENV: 'test',
  DATABASE_URL: pgUrl,
  REDIS_URL: redisUrl,
  SSE_RECONCILE_MS: '100',
});
const store = new PostgresStore(pgUrl);
const bus1 = new RedisBus(redisUrl, logger);
const bus2 = new RedisBus(redisUrl, logger);
const auth = new AuthService(store, 1);
const createdWorkspaces: string[] = [];
let admin: Actor;
let token: string;
let server: Server | undefined;
let hub: SseHub | undefined;

before(
  async () => {
    await store.migrate();
    await Promise.all([bus1.connect(), bus2.connect()]);
    const result = await auth.register({
      name: 'Test Admin',
      email: `${randomUUID()}@example.test`,
      password: 'integration-test-password',
      workspaceName: 'Disposable test workspace',
    });
    admin = result.actor;
    token = result.token;
    createdWorkspaces.push(admin.workspaceId);
  },
  { timeout: 15000 },
);
after(async () => {
  hub?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  for (const id of createdWorkspaces)
    await store.pool.query('DELETE FROM workspaces WHERE id = $1', [id]);
  await Promise.all([bus1.close(), bus2.close(), store.close()]);
});

test('migrations are idempotent and database-backed sessions support login and revocation', async () => {
  await store.migrate();
  const login = await auth.login(admin.email, 'integration-test-password');
  assert.equal((await auth.authenticate(login.token)).id, admin.id);
  await auth.logout(login.token);
  await assert.rejects(auth.authenticate(login.token), { status: 401 });
});
test('concurrent publishers produce unique ordered workspace sequences', async () => {
  const events = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      store.createEvent(admin, {
        title: `Concurrent ${index}`,
        body: 'Transaction ordering test',
        kind: 'deployment',
      }),
    ),
  );
  const sequences = events.map((event) => BigInt(event.sequence)).sort((a, b) => (a < b ? -1 : 1));
  assert.equal(new Set(sequences).size, 12);
  for (let index = 1; index < sequences.length; index++)
    assert.equal(sequences[index]! - sequences[index - 1]!, 1n);
  const replay = await store.after(admin, '0', 100);
  assert.equal(replay.length, 12);
  assert.deepEqual(
    replay.map((event) => BigInt(event.sequence)),
    sequences,
  );
});
test('failed insert rolls back its workspace counter and leaves no phantom event', async () => {
  const head = (await store.history(admin, undefined, 1)).cursor;
  await assert.rejects(
    store.createEvent(admin, {
      title: 'x'.repeat(121),
      body: 'Invalid database-level input',
      kind: 'incident',
    }),
  );
  assert.equal((await store.history(admin, undefined, 1)).cursor, head);
});
test('database queries isolate workspaces and per-user read receipts', async () => {
  const second = await auth.register({
    name: 'Other',
    email: `${randomUUID()}@example.test`,
    password: 'another-test-password',
    workspaceName: 'Other workspace',
  });
  createdWorkspaces.push(second.actor.workspaceId);
  const event = await store.createEvent(admin, {
    title: 'Private to workspace',
    body: 'Isolation test',
    kind: 'incident',
  });
  assert.deepEqual((await store.history(second.actor, undefined, 25)).items, []);
  assert.equal(await store.markRead(second.actor, event.id, true), false);
  const member = await auth.addMember(admin, {
    name: 'Reader',
    email: `${randomUUID()}@example.test`,
    password: 'member-test-password',
  });
  assert.equal(await store.markRead(member, event.id, true), true);
  assert.equal(await store.markRead(member, event.id, true), true);
  assert.equal((await store.history(member, undefined, 1)).items[0]!.read, true);
  assert.equal((await store.history(admin, undefined, 1)).items[0]!.read, false);
});
test(
  'Redis publish in one adapter wakes a separate subscriber',
  async () => {
    const received = new Promise<string>((resolve) => {
      const off = bus2.onHint((workspaceId) => {
        if (workspaceId === admin.workspaceId) {
          off();
          resolve(workspaceId);
        }
      });
    });
    await bus1.publish(admin.workspaceId);
    assert.equal(await received, admin.workspaceId);
  },
  { timeout: 3000 },
);
test('an SSE connection on another API instance receives committed events', async () => {
  hub = new SseHub(store, bus2, config, logger);
  server = createApp({ store, bus: bus2, config, logger, stream: hub }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const head = (await store.history(admin, undefined, 1)).cursor;
  const response = await fetch(`${base}/api/events/stream?after=${head}`, {
    headers: { Cookie: `sd_session=${token}` },
    signal: AbortSignal.timeout(3000),
  });
  const created = await new EventService(store, bus1, logger).create(admin, {
    title: 'Cross-instance update',
    body: 'Committed then broadcast',
    kind: 'announcement',
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes(created.id)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('SSE ended before delivery');
    buffer += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(buffer, /event: activity/);
  await reader.cancel();
});
