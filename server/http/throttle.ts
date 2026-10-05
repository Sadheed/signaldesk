import { AppError } from '../domain/errors.ts';

export class Throttle {
  private entries = new Map<string, { count: number; expires: number }>();
  private limit: number;
  private windowMs: number;
  constructor(limit = 20, windowMs = 15 * 60000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  check(key: string, now = Date.now()): void {
    const previous = this.entries.get(key);
    if (!previous || previous.expires <= now) {
      if (this.entries.size >= 10000) {
        for (const [id, entry] of this.entries) if (entry.expires <= now) this.entries.delete(id);
        if (this.entries.size >= 10000)
          throw new AppError(503, 'THROTTLE_BUSY', 'Please try again later');
      }
      this.entries.set(key, { count: 1, expires: now + this.windowMs });
      return;
    }
    if (previous.count >= this.limit)
      throw new AppError(429, 'RATE_LIMITED', 'Too many attempts; try again later');
    previous.count++;
  }
}
