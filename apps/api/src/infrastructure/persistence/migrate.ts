import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';

const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

// An arbitrary but fixed key. Two migrators starting together must serialize
// rather than race, and an advisory lock is released automatically if one dies.
const MIGRATION_ADVISORY_LOCK_KEY = 8_527_413_009_112_233n;

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export class MigrationChecksumMismatchError extends Error {
  public constructor(name: string) {
    super(
      `Migration ${name} has changed after being applied. Applied migrations are immutable; ` +
        'add a new migration instead of editing this one.',
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

export async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory);
  const migrationNames = entries
    .filter((entry) => MIGRATION_FILE_PATTERN.test(entry))
    .toSorted((left, right) => left.localeCompare(right, 'en'));

  const files: MigrationFile[] = [];
  for (const name of migrationNames) {
    const sql = await readFile(path.join(directory, name), 'utf8');
    files.push({
      version: MIGRATION_FILE_PATTERN.exec(name)?.[1] ?? '',
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return files;
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export interface MigrationOutcome {
  readonly applied: string[];
  readonly alreadyApplied: string[];
}

/**
 * Each migration runs inside its own transaction together with the row recording
 * it, so a failure leaves neither a half-applied schema nor a false record of one.
 */
export async function applyMigrations(
  client: PoolClient,
  files: readonly MigrationFile[],
): Promise<MigrationOutcome> {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY.toString()]);

  try {
    await ensureMigrationTable(client);

    const recorded = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const appliedChecksums = new Map(recorded.rows.map((row) => [row.name, row.checksum]));

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const file of files) {
      const existingChecksum = appliedChecksums.get(file.name);

      if (existingChecksum === file.checksum) {
        alreadyApplied.push(file.name);
        continue;
      }
      if (existingChecksum !== undefined) {
        throw new MigrationChecksumMismatchError(file.name);
      }

      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file.name,
          file.checksum,
        ]);
        await client.query('COMMIT');
        applied.push(file.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
  }
}
