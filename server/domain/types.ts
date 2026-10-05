export type Role = 'admin' | 'member';
export type EventKind = 'deployment' | 'incident' | 'announcement';
export type Cursor = string;

export interface Actor {
  id: string;
  workspaceId: string;
  workspaceName: string;
  name: string;
  email: string;
  role: Role;
}

export interface Activity {
  id: string;
  sequence: Cursor;
  workspaceId: string;
  title: string;
  body: string;
  kind: EventKind;
  actorName: string;
  createdAt: string;
  read: boolean;
}

export interface EventInput {
  title: string;
  body: string;
  kind: EventKind;
}
export interface MemberInput {
  name: string;
  email: string;
  password: string;
}
export interface Registration extends MemberInput {
  workspaceName: string;
}
export interface StoredUser extends Actor {
  passwordHash: string;
}
export interface FeedPage {
  items: Activity[];
  cursor: Cursor;
  nextBefore: Cursor | null;
}

export interface Store {
  register(input: Omit<Registration, 'password'>, passwordHash: string): Promise<Actor>;
  findUser(email: string): Promise<StoredUser | null>;
  createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void>;
  session(tokenHash: string): Promise<Actor | null>;
  revokeSession(tokenHash: string): Promise<void>;
  addMember(
    actor: Actor,
    input: Omit<MemberInput, 'password'>,
    passwordHash: string,
  ): Promise<Actor>;
  members(actor: Actor): Promise<Pick<Actor, 'id' | 'name' | 'email' | 'role'>[]>;
  createEvent(actor: Actor, input: EventInput): Promise<Activity>;
  history(actor: Actor, before: Cursor | undefined, limit: number): Promise<FeedPage>;
  after(actor: Actor, cursor: Cursor, limit: number): Promise<Activity[]>;
  markRead(actor: Actor, eventId: string, read: boolean): Promise<boolean>;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}

export interface EventBus {
  onHint(listener: (workspaceId: string) => void): () => void;
  publish(workspaceId: string): Promise<void>;
  healthy(): boolean;
  close(): Promise<void>;
}
