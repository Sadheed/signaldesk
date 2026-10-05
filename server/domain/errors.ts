export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requireAdmin(role: string): void {
  if (role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Workspace admin access required');
}

export function parseCursor(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new AppError(400, 'INVALID_CURSOR', 'Cursor must be a nonnegative PostgreSQL bigint');
  }
  return value;
}
