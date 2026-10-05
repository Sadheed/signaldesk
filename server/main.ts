import { PostgresStore } from './adapters/postgres.ts';
import { RedisBus } from './adapters/redis.ts';
import { readConfig } from './config.ts';
import { createApp } from './http/app.ts';
import { makeLogger } from './logger.ts';
import { SseHub } from './realtime/hub.ts';

const config = readConfig();
const logger = makeLogger(config.LOG_LEVEL);
const store = new PostgresStore(config.DATABASE_URL);
store.pool.on('error', () => logger.error('postgres_pool_error'));
const bus = new RedisBus(config.REDIS_URL, logger);
const hub = new SseHub(store, bus, config, logger);
if (!(await store.healthy())) {
  logger.error('postgres_unavailable');
  await store.close();
  process.exit(1);
}
// Reconciliation keeps streams useful even while Redis is reconnecting.
void bus.connect().catch(() => logger.error('redis_connect_failed'));
const server = createApp({ store, bus, config, logger, stream: hub }).listen(config.PORT, () =>
  logger.info('server_started', { port: config.PORT }),
);
server.requestTimeout = 30000;
server.headersTimeout = 15000;
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info('shutdown_started', { signal });
  const deadline = setTimeout(() => {
    logger.error('shutdown_deadline');
    process.exit(1);
  }, 10000);
  deadline.unref();
  hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([bus.close(), store.close()]);
  clearTimeout(deadline);
  logger.info('shutdown_complete');
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void shutdown(signal).catch(() => {
      logger.error('shutdown_failed');
      process.exitCode = 1;
    });
  });
server.on('error', () => {
  logger.error('http_server_error');
  void shutdown('server-error');
});
