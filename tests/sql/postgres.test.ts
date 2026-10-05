import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Optional CLI-level checks: real SQL, independent of the unavailable npm pg driver.
const execute = promisify(execFile);
const executable = process.env.PSQL_BIN ?? 'psql';
const host = process.env.PGHOST ?? '127.0.0.1';
if (!['localhost', '127.0.0.1'].includes(host))
  throw new Error('SQL tests require a local disposable PostgreSQL server');
const connection = [
  '-h',
  host,
  '-p',
  process.env.PGPORT ?? '5432',
  '-U',
  process.env.PGUSER ?? 'signaldesk',
  '-v',
  'ON_ERROR_STOP=1',
];
const name = `signaldesk_test_${randomUUID().replaceAll('-', '')}`;
let created = false;
const psql = (database: string, args: string[]) =>
  execute(executable, [...connection, '-d', database, ...args], { timeout: 15000 });
const sql = (text: string) => psql(name, ['-At', '-c', text]);
before(async () => {
  await psql('postgres', ['-c', `CREATE DATABASE ${name}`]);
  created = true;
  await psql(name, ['-f', fileURLToPath(new URL('../../db/001_initial.sql', import.meta.url))]);
});
after(async () => {
  if (created) await psql('postgres', ['-c', `DROP DATABASE ${name}`]);
});

test('schema constraints, receipt idempotency, and workspace cascades hold in PostgreSQL', async () => {
  await psql(name, ['-f', fileURLToPath(new URL('../integration/schema.sql', import.meta.url))]);
  assert.equal((await sql('SELECT count(*) FROM workspaces')).stdout.trim(), '0');
});
test('twelve concurrent SQL transactions allocate a contiguous committed event sequence', async () => {
  await sql(
    "INSERT INTO workspaces(id,name) VALUES ('00000000-0000-4000-8000-000000000001','Concurrency'); INSERT INTO users(id,workspace_id,name,email,password_hash,role) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Test','sql@example.test','unused','admin');",
  );
  await Promise.all(
    Array.from({ length: 12 }, () =>
      sql(
        `BEGIN; UPDATE workspaces SET next_sequence=next_sequence+1 WHERE id='00000000-0000-4000-8000-000000000001'; SELECT pg_sleep(0.01); INSERT INTO events(id,workspace_id,sequence,title,body,kind,actor_id) SELECT '${randomUUID()}',id,next_sequence,'Concurrent','Test','deployment','00000000-0000-4000-8000-000000000002' FROM workspaces WHERE id='00000000-0000-4000-8000-000000000001'; COMMIT;`,
      ),
    ),
  );
  const result = await sql(
    "SELECT sequence FROM events WHERE workspace_id='00000000-0000-4000-8000-000000000001' ORDER BY sequence",
  );
  assert.deepEqual(
    result.stdout.trim().split(/\s+/),
    Array.from({ length: 12 }, (_, index) => String(index + 1)),
  );
});
test('an invalid event insert rolls back its counter increment', async () => {
  await assert.rejects(
    sql(
      `BEGIN; UPDATE workspaces SET next_sequence=next_sequence+1 WHERE id='00000000-0000-4000-8000-000000000001'; INSERT INTO events(id,workspace_id,sequence,title,body,kind,actor_id) SELECT '${randomUUID()}',id,next_sequence,'${'x'.repeat(121)}','Test','incident','00000000-0000-4000-8000-000000000002' FROM workspaces WHERE id='00000000-0000-4000-8000-000000000001'; COMMIT;`,
    ),
  );
  assert.equal(
    (
      await sql(
        "SELECT next_sequence FROM workspaces WHERE id='00000000-0000-4000-8000-000000000001'",
      )
    ).stdout.trim(),
    '12',
  );
  assert.equal((await sql('SELECT count(*) FROM events')).stdout.trim(), '12');
});
