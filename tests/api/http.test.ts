import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/http/app.ts';
import { readConfig } from '../../server/config.ts';
import { MemoryBus, MemoryStore } from '../support/memory.ts';

const store = new MemoryStore();
const bus = new MemoryBus();
const logger = { info() {}, warn() {}, error() {} };
const config = readConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://unused',
  REDIS_URL: 'redis://unused',
});
let server: Server;
let base: string;
let adminCookie: string;
let otherCookie: string;
let memberCookie: string;
let eventId: string;

async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie?: string,
  origin?: string,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
before(async () => {
  server = createApp({ store, bus, config, logger }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('register sets an HttpOnly session and never returns a token/password hash', async () => {
  const response = await call('/api/auth/register', 'POST', {
    name: 'Ada',
    email: 'ADA@example.test',
    password: 'a-long-demo-password',
    workspaceName: 'Platform',
  });
  assert.equal(response.status, 201);
  assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(response.headers.get('set-cookie')!, /SameSite=Strict/);
  adminCookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const actor = await response.json();
  assert.equal(actor.email, 'ada@example.test');
  assert.equal(actor.role, 'admin');
  assert.equal(actor.token, undefined);
  assert.equal(actor.passwordHash, undefined);
});
test('validation, foreign origins, malformed JSON and anonymous access are rejected', async () => {
  assert.equal((await call('/api/events')).status, 401);
  assert.equal((await call('/api/auth/register', 'POST', {})).status, 400);
  assert.equal(
    (await call('/api/events', 'POST', {}, adminCookie, 'https://attacker.test')).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
    400,
  );
});
test('admin creates activity; Redis hint failure still returns the committed event', async () => {
  bus.available = false;
  const response = await call(
    '/api/events',
    'POST',
    { title: 'Deployment complete', body: 'Version 1.2 is available', kind: 'deployment' },
    adminCookie,
  );
  bus.available = true;
  assert.equal(response.status, 201);
  const event = await response.json();
  eventId = event.id;
  assert.equal(event.sequence, '1');
  assert.equal(store.events.length, 1);
});
test('another workspace cannot list or mark the event read', async () => {
  const response = await call('/api/auth/register', 'POST', {
    name: 'Grace',
    email: 'grace@example.test',
    password: 'another-long-password',
    workspaceName: 'Other team',
  });
  otherCookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const feed = await call('/api/events', 'GET', undefined, otherCookie);
  assert.deepEqual((await feed.json()).items, []);
  assert.equal(
    (await call(`/api/events/${eventId}/read`, 'PUT', { read: true }, otherCookie)).status,
    404,
  );
});
test('admin provisions a member, but members cannot publish or add accounts', async () => {
  const response = await call(
    '/api/members',
    'POST',
    { name: 'Lin', email: 'lin@example.test', password: 'member-long-password' },
    adminCookie,
  );
  assert.equal(response.status, 201);
  const login = await call('/api/auth/login', 'POST', {
    email: 'lin@example.test',
    password: 'member-long-password',
  });
  assert.equal(login.status, 200);
  memberCookie = login.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal(
    (
      await call(
        '/api/events',
        'POST',
        { title: 'Denied', body: 'Denied', kind: 'incident' },
        memberCookie,
      )
    ).status,
    403,
  );
  assert.equal((await call('/api/members', 'POST', {}, memberCookie)).status, 403);
});
test('read receipts are per-user and idempotent; pagination input is validated', async () => {
  for (let attempt = 0; attempt < 2; attempt++)
    assert.equal(
      (await call(`/api/events/${eventId}/read`, 'PUT', { read: true }, memberCookie)).status,
      204,
    );
  const memberFeed = await (await call('/api/events', 'GET', undefined, memberCookie)).json();
  const adminFeed = await (await call('/api/events', 'GET', undefined, adminCookie)).json();
  assert.equal(memberFeed.items[0].read, true);
  assert.equal(adminFeed.items[0].read, false);
  assert.equal((await call('/api/events?before=-1', 'GET', undefined, adminCookie)).status, 400);
  assert.equal((await call('/api/events?limit=1000', 'GET', undefined, adminCookie)).status, 400);
});
test('logout revokes the server-side session and failed login uses a generic message', async () => {
  assert.equal((await call('/api/auth/logout', 'POST', undefined, otherCookie)).status, 204);
  assert.equal((await call('/api/me', 'GET', undefined, otherCookie)).status, 401);
  const login = await call('/api/auth/login', 'POST', {
    email: 'unknown@example.test',
    password: 'incorrect',
  });
  assert.equal(login.status, 401);
  assert.equal((await login.json()).error.code, 'INVALID_CREDENTIALS');
});
test('health distinguishes process liveness from dependency readiness', async () => {
  assert.equal((await call('/health/live')).status, 200);
  bus.available = false;
  assert.equal((await call('/health/ready')).status, 503);
  bus.available = true;
  assert.equal((await call('/health/ready')).status, 200);
});
