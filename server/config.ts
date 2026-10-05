import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().startsWith('postgres'),
  REDIS_URL: z.string().startsWith('redis'),
  LOG_LEVEL: z.enum(['info', 'warn', 'error']).default('info'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  SSE_RECONCILE_MS: z.coerce.number().int().min(100).max(30000).default(5000),
  SSE_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
  SSE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(10000).default(100),
  SSE_MAX_PER_USER: z.coerce.number().int().min(1).max(20).default(3),
});
export type Config = z.infer<typeof schema>;
export function readConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(environment);
  if (!result.success)
    throw new Error(
      `Invalid configuration fields: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  const config = result.data;
  const origin = new URL(config.APP_ORIGIN);
  if (origin.origin !== config.APP_ORIGIN)
    throw new Error('APP_ORIGIN must be an origin without a trailing slash or path');
  if (config.NODE_ENV === 'production' && origin.protocol !== 'https:')
    throw new Error('Production APP_ORIGIN requires HTTPS');
  return config;
}
