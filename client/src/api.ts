export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    signal,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: { message?: string; requestId?: string };
    } | null;
    throw new ApiError(
      response.status,
      data?.error?.message ?? 'Request failed. Please try again.',
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const messageFrom = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong';
