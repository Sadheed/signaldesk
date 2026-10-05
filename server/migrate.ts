import { PostgresStore } from './adapters/postgres.ts';
import { readConfig } from './config.ts';
import { makeLogger } from './logger.ts';

const store = new PostgresStore(readConfig().DATABASE_URL);
const logger = makeLogger();
try { await store.migrate(); logger.info('migrations_applied'); }
catch { logger.error('migration_failed'); process.exitCode = 1; }
finally { await store.close(); }
