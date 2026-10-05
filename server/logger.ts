type Level = 'info' | 'warn' | 'error';
export interface Logger { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void; error(event: string, fields?: Record<string, unknown>): void }

export function makeLogger(minimum: Level = 'info'): Logger {
  const ranks: Record<Level, number> = { info: 0, warn: 1, error: 2 };
  const emit = (level: Level, event: string, fields: Record<string, unknown> = {}) => {
    if (ranks[level] < ranks[minimum]) return;
    // Call sites pass identifiers/counters, never request bodies or connection URLs.
    console.log(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }));
  };
  return { info: (e, f) => emit('info', e, f), warn: (e, f) => emit('warn', e, f), error: (e, f) => emit('error', e, f) };
}
