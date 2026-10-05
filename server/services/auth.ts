import type { Actor, MemberInput, Registration, Store } from '../domain/types.ts';
import { AppError, requireAdmin } from '../domain/errors.ts';
import { hashPassword, verifyPassword, newToken, hashToken } from '../security.ts';

export class AuthService {
  private readonly store: Store;
  private readonly ttlHours: number;
  private readonly dummyHash: Promise<string>;
  private hashing = 0;
  constructor(store: Store, ttlHours: number) {
    this.store = store;
    this.ttlHours = ttlHours;
    this.dummyHash = hashPassword('dummy-password-not-used-for-an-account');
  }
  private async expensive<T>(work: () => Promise<T>): Promise<T> {
    if (this.hashing >= 4)
      throw new AppError(503, 'AUTH_BUSY', 'Authentication busy; try again shortly');
    this.hashing++;
    try {
      return await work();
    } finally {
      this.hashing--;
    }
  }
  async register(input: Registration): Promise<{ actor: Actor; token: string }> {
    const passwordHash = await this.expensive(() => hashPassword(input.password));
    const { password: _password, ...profile } = input;
    const actor = await this.store.register(profile, passwordHash);
    return { actor, token: await this.issueSession(actor.id) };
  }
  async login(email: string, password: string): Promise<{ actor: Actor; token: string }> {
    const user = await this.store.findUser(email);
    const expected = user?.passwordHash ?? (await this.dummyHash);
    const valid = await this.expensive(() => verifyPassword(password, expected));
    if (!user || !valid)
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    const { passwordHash: _hash, ...actor } = user;
    return { actor, token: await this.issueSession(actor.id) };
  }
  async issueSession(userId: string): Promise<string> {
    const token = newToken();
    await this.store.createSession(
      hashToken(token),
      userId,
      new Date(Date.now() + this.ttlHours * 3600000),
    );
    return token;
  }
  async authenticate(token: string | undefined): Promise<Actor> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    const actor = await this.store.session(hashToken(token));
    if (!actor) throw new AppError(401, 'UNAUTHENTICATED', 'Session expired or revoked');
    return actor;
  }
  async logout(token: string | undefined): Promise<void> {
    if (token) await this.store.revokeSession(hashToken(token));
  }
  async addMember(actor: Actor, input: MemberInput): Promise<Actor> {
    requireAdmin(actor.role);
    const passwordHash = await this.expensive(() => hashPassword(input.password));
    const { password: _password, ...profile } = input;
    return this.store.addMember(actor, profile, passwordHash);
  }
}
