import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Actor, Activity, Cursor, EventInput, FeedPage, MemberInput, Registration, Store, StoredUser } from '../domain/types.ts';

interface UserRow extends QueryResultRow {
  id: string; workspace_id: string; workspace_name: string; name: string;
  email: string; role: Actor['role']; password_hash: string;
}
interface EventRow extends QueryResultRow {
  id: string; workspace_id: string; sequence: string; title: string; body: string;
  kind: Activity['kind']; actor_name: string; created_at: Date; read: boolean;
}
const actorFrom = (row: UserRow): Actor => ({ id: row.id, workspaceId: row.workspace_id, workspaceName: row.workspace_name, name: row.name, email: row.email, role: row.role });
const activityFrom = (row: EventRow): Activity => ({ id: row.id, workspaceId: row.workspace_id, sequence: row.sequence, title: row.title, body: row.body, kind: row.kind, actorName: row.actor_name, createdAt: row.created_at.toISOString(), read: row.read });
const userSelect = 'SELECT u.*, w.name AS workspace_name FROM users u JOIN workspaces w ON w.id = u.workspace_id';
const eventSelect = `SELECT e.*, u.name AS actor_name, EXISTS(SELECT 1 FROM read_receipts r WHERE r.event_id = e.id AND r.user_id = $1) AS read FROM events e JOIN users u ON u.id = e.actor_id`;

export class PostgresStore implements Store {
  readonly pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 10000 });
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async migrate(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(738291)');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
      const directory = new URL('../../db/', import.meta.url);
      const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
      for (const name of files) {
        const sql = await readFile(new URL(name, directory), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const existing = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name = $1', [name]);
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
          continue;
        }
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
      }
    });
  }

  async register(input: Omit<Registration, 'password'>, passwordHash: string): Promise<Actor> {
    return this.transaction(async (client) => {
      const workspaceId = randomUUID();
      const id = randomUUID();
      await client.query('INSERT INTO workspaces(id, name) VALUES ($1, $2)', [workspaceId, input.workspaceName]);
      await client.query("INSERT INTO users(id, workspace_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5, 'admin')", [id, workspaceId, input.name, input.email, passwordHash]);
      return { id, workspaceId, workspaceName: input.workspaceName, name: input.name, email: input.email, role: 'admin' };
    });
  }
  async findUser(email: string): Promise<StoredUser | null> {
    const result = await this.pool.query<UserRow>(`${userSelect} WHERE u.email = $1`, [email]);
    const row = result.rows[0];
    return row ? { ...actorFrom(row), passwordHash: row.password_hash } : null;
  }
  async createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    await this.pool.query('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, expiresAt]);
  }
  async session(tokenHash: string): Promise<Actor | null> {
    const result = await this.pool.query<UserRow>(`${userSelect} JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = $1 AND s.expires_at > now()`, [tokenHash]);
    return result.rows[0] ? actorFrom(result.rows[0]) : null;
  }
  async revokeSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }
  async addMember(actor: Actor, input: Omit<MemberInput, 'password'>, passwordHash: string): Promise<Actor> {
    const id = randomUUID();
    await this.pool.query("INSERT INTO users(id, workspace_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5, 'member')", [id, actor.workspaceId, input.name, input.email, passwordHash]);
    return { id, workspaceId: actor.workspaceId, workspaceName: actor.workspaceName, name: input.name, email: input.email, role: 'member' };
  }
  async members(actor: Actor): Promise<Pick<Actor, 'id' | 'name' | 'email' | 'role'>[]> {
    return (await this.pool.query<Pick<Actor, 'id' | 'name' | 'email' | 'role'>>('SELECT id, name, email, role FROM users WHERE workspace_id = $1 ORDER BY created_at', [actor.workspaceId])).rows;
  }
  async createEvent(actor: Actor, input: EventInput): Promise<Activity> {
    return this.transaction(async (client) => {
      const counter = await client.query<{ next_sequence: string }>('UPDATE workspaces SET next_sequence = next_sequence + 1 WHERE id = $1 RETURNING next_sequence', [actor.workspaceId]);
      const sequence = counter.rows[0]?.next_sequence;
      if (!sequence) throw new Error('Workspace disappeared');
      const id = randomUUID();
      const result = await client.query<{ created_at: Date }>('INSERT INTO events(id, workspace_id, sequence, title, body, kind, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING created_at', [id, actor.workspaceId, sequence, input.title, input.body, input.kind, actor.id]);
      const created = result.rows[0];
      if (!created) throw new Error('Event was not inserted');
      return { id, workspaceId: actor.workspaceId, sequence, ...input, actorName: actor.name, createdAt: created.created_at.toISOString(), read: false };
    });
  }
  async history(actor: Actor, before: Cursor | undefined, limit: number): Promise<FeedPage> {
    const head = await this.pool.query<{ next_sequence: string }>('SELECT next_sequence FROM workspaces WHERE id = $1', [actor.workspaceId]);
    const cursor = head.rows[0]?.next_sequence ?? '0';
    const rows = await this.pool.query<EventRow>(`${eventSelect} WHERE e.workspace_id = $2 AND e.sequence <= $3 AND ($4::bigint IS NULL OR e.sequence < $4) ORDER BY e.sequence DESC LIMIT $5`, [actor.id, actor.workspaceId, cursor, before ?? null, limit + 1]);
    const items = rows.rows.slice(0, limit).map(activityFrom);
    return { items, cursor, nextBefore: rows.rows.length > limit ? items.at(-1)?.sequence ?? null : null };
  }
  async after(actor: Actor, cursor: Cursor, limit: number): Promise<Activity[]> {
    return (await this.pool.query<EventRow>(`${eventSelect} WHERE e.workspace_id = $2 AND e.sequence > $3 ORDER BY e.sequence ASC LIMIT $4`, [actor.id, actor.workspaceId, cursor, limit])).rows.map(activityFrom);
  }
  async markRead(actor: Actor, eventId: string, read: boolean): Promise<boolean> {
    if (read) {
      const result = await this.pool.query('INSERT INTO read_receipts(event_id, user_id) SELECT id, $1 FROM events WHERE id = $2 AND workspace_id = $3 ON CONFLICT (event_id, user_id) DO UPDATE SET read_at = read_receipts.read_at RETURNING event_id', [actor.id, eventId, actor.workspaceId]);
      return result.rowCount === 1;
    }
    return this.transaction(async (client) => {
      const found = await client.query('SELECT id FROM events WHERE id = $1 AND workspace_id = $2', [eventId, actor.workspaceId]);
      if (found.rowCount !== 1) return false;
      await client.query('DELETE FROM read_receipts WHERE event_id = $1 AND user_id = $2', [eventId, actor.id]);
      return true;
    });
  }
  async healthy(): Promise<boolean> {
    try { await this.pool.query('SELECT 1'); return true; } catch { return false; }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
