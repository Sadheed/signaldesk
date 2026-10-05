// Test adapter only. Production always uses PostgreSQL and Redis.
import { randomUUID } from 'node:crypto';
import type {
  Actor,
  Activity,
  Cursor,
  EventBus,
  EventInput,
  FeedPage,
  MemberInput,
  Registration,
  Store,
  StoredUser,
} from '../../server/domain/types.ts';

export class MemoryStore implements Store {
  users = new Map<string, StoredUser>();
  sessions = new Map<string, { userId: string; expiresAt: Date }>();
  events: Activity[] = [];
  reads = new Set<string>();
  async register(input: Omit<Registration, 'password'>, passwordHash: string): Promise<Actor> {
    if ([...this.users.values()].some((user) => user.email === input.email))
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    const user: StoredUser = {
      id: randomUUID(),
      workspaceId: randomUUID(),
      workspaceName: input.workspaceName,
      name: input.name,
      email: input.email,
      role: 'admin',
      passwordHash,
    };
    this.users.set(user.id, user);
    const { passwordHash: _hash, ...actor } = user;
    return actor;
  }
  async findUser(email: string): Promise<StoredUser | null> {
    return [...this.users.values()].find((user) => user.email === email) ?? null;
  }
  async createSession(hash: string, userId: string, expiresAt: Date): Promise<void> {
    this.sessions.set(hash, { userId, expiresAt });
  }
  async session(hash: string): Promise<Actor | null> {
    const session = this.sessions.get(hash);
    const user =
      session && session.expiresAt > new Date() ? this.users.get(session.userId) : undefined;
    if (!user) return null;
    const { passwordHash: _hash, ...actor } = user;
    return actor;
  }
  async revokeSession(hash: string): Promise<void> {
    this.sessions.delete(hash);
  }
  async addMember(
    actor: Actor,
    input: Omit<MemberInput, 'password'>,
    passwordHash: string,
  ): Promise<Actor> {
    if ([...this.users.values()].some((user) => user.email === input.email))
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    const member: Actor = { ...actor, ...input, id: randomUUID(), role: 'member' };
    this.users.set(member.id, { ...member, passwordHash });
    return member;
  }
  async members(actor: Actor): Promise<Pick<Actor, 'id' | 'name' | 'email' | 'role'>[]> {
    return [...this.users.values()]
      .filter((user) => user.workspaceId === actor.workspaceId)
      .map(({ id, name, email, role }) => ({ id, name, email, role }));
  }
  async createEvent(actor: Actor, input: EventInput): Promise<Activity> {
    const previous = this.events.filter((event) => event.workspaceId === actor.workspaceId).at(-1);
    const event: Activity = {
      ...input,
      id: randomUUID(),
      workspaceId: actor.workspaceId,
      sequence: (BigInt(previous?.sequence ?? '0') + 1n).toString(),
      actorName: actor.name,
      createdAt: new Date().toISOString(),
      read: false,
    };
    this.events.push(event);
    return { ...event };
  }
  private forActor(actor: Actor): Activity[] {
    return this.events
      .filter((event) => event.workspaceId === actor.workspaceId)
      .map((event) => ({ ...event, read: this.reads.has(`${actor.id}:${event.id}`) }));
  }
  async history(actor: Actor, before: Cursor | undefined, limit: number): Promise<FeedPage> {
    const all = this.forActor(actor);
    const rows = all
      .filter((event) => before === undefined || BigInt(event.sequence) < BigInt(before))
      .reverse();
    const items = rows.slice(0, limit);
    return {
      items,
      cursor: all.at(-1)?.sequence ?? '0',
      nextBefore: rows.length > limit ? (items.at(-1)?.sequence ?? null) : null,
    };
  }
  async after(actor: Actor, cursor: Cursor, limit: number): Promise<Activity[]> {
    return this.forActor(actor)
      .filter((event) => BigInt(event.sequence) > BigInt(cursor))
      .slice(0, limit);
  }
  async markRead(actor: Actor, id: string, read: boolean): Promise<boolean> {
    if (!this.events.some((event) => event.id === id && event.workspaceId === actor.workspaceId))
      return false;
    const key = `${actor.id}:${id}`;
    if (read) this.reads.add(key);
    else this.reads.delete(key);
    return true;
  }
  async healthy(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

export class MemoryBus implements EventBus {
  listeners = new Set<(workspaceId: string) => void>();
  available = true;
  onHint(listener: (workspaceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async publish(workspaceId: string): Promise<void> {
    if (!this.available) throw new Error('Redis unavailable');
    for (const listener of this.listeners) listener(workspaceId);
  }
  healthy(): boolean {
    return this.available;
  }
  async close(): Promise<void> {
    this.listeners.clear();
  }
}
