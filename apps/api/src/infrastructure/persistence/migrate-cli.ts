import path from 'node:path';
import { Pool } from 'pg';
import { loadDatabaseEnvironment } from '../configuration/environment.js';
import { createLogger } from '../logging/logger.js';
import { applyMigrations, readMigrationFiles } from './migrate.js';

// dist/infrastructure/persistence -> apps/api, where the migrations directory sits.
const MIGRATIONS_DIRECTORY =
  process.env.MIGRATIONS_DIRECTORY ??
  path.join(import.meta.dirname, '..', '..', '..', 'migrations');

const environment = loadDatabaseEnvironment();
const logger = createLogger(environment);

const pool = new Pool({
  connectionString: environment.DATABASE_URL,
  max: 1,
  application_name: 'payment-gateway-migrator',
});

const client = await pool.connect();

try {
  const files = await readMigrationFiles(MIGRATIONS_DIRECTORY);
  logger.info({ directory: MIGRATIONS_DIRECTORY, count: files.length }, 'migrations discovered');

  const outcome = await applyMigrations(client, files);

  logger.info(
    { applied: outcome.applied, alreadyApplied: outcome.alreadyApplied.length },
    'migrations complete',
  );
} catch (error) {
  logger.fatal({ error }, 'migration failed');
  client.release();
  await pool.end();
  process.exit(1);
}

client.release();
await pool.end();
