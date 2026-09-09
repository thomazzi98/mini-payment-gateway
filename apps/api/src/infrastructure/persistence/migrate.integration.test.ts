import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, MigrationChecksumMismatchError, readMigrationFiles } from './migrate.js';
import { createOwnerPool } from './test-database.js';

/**
 * Runs against the real database, because the behaviour worth proving — that an
 * already-applied migration cannot be quietly edited — lives in the interaction
 * between the files on disk and the rows recorded in schema_migrations.
 *
 * The fixtures use their own throwaway table and are removed afterwards, so the
 * real schema is left exactly as it was found.
 */

interface MigrationFixture {
  ownerPool: Pool;
  directory: string;
}

const fixture = {} as MigrationFixture;
const FIXTURE_MIGRATION = '9001_migration_runner_fixture.sql';
const FIXTURE_TABLE = 'migration_runner_fixture';

async function withClient<Result>(work: (client: PoolClient) => Promise<Result>): Promise<Result> {
  const client = await fixture.ownerPool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  fixture.ownerPool = createOwnerPool();
  fixture.directory = await mkdtemp(path.join(tmpdir(), 'gateway-migrations-'));
});

afterAll(async () => {
  await fixture.ownerPool.query(`DROP TABLE IF EXISTS ${FIXTURE_TABLE}`);
  await fixture.ownerPool.query('DELETE FROM schema_migrations WHERE name = $1', [
    FIXTURE_MIGRATION,
  ]);
  await fixture.ownerPool.end();
  await rm(fixture.directory, { recursive: true, force: true });
});

describe('reading migration files', () => {
  it('ignores anything that is not a numbered migration', async () => {
    await writeFile(path.join(fixture.directory, 'README.md'), '# not a migration');
    await writeFile(path.join(fixture.directory, 'draft.sql'), 'SELECT 1');
    await writeFile(
      path.join(fixture.directory, FIXTURE_MIGRATION),
      `CREATE TABLE ${FIXTURE_TABLE} (id integer PRIMARY KEY)`,
    );

    const files = await readMigrationFiles(fixture.directory);

    expect(files.map((file) => file.name)).toEqual([FIXTURE_MIGRATION]);
    expect(files[0]?.version).toBe('9001');
    expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('applying migrations', () => {
  it('applies a migration once and records it', async () => {
    const files = await readMigrationFiles(fixture.directory);
    const outcome = await withClient((client) => applyMigrations(client, files));

    expect(outcome.applied).toContain(FIXTURE_MIGRATION);

    const created = await fixture.ownerPool.query('SELECT to_regclass($1) IS NOT NULL AS exists', [
      FIXTURE_TABLE,
    ]);
    expect(created.rows[0]).toEqual({ exists: true });
  });

  it('is idempotent: a second run applies nothing', async () => {
    const files = await readMigrationFiles(fixture.directory);
    const outcome = await withClient((client) => applyMigrations(client, files));

    expect(outcome.applied).toEqual([]);
    expect(outcome.alreadyApplied).toContain(FIXTURE_MIGRATION);
  });

  it('refuses to run when an applied migration has been edited', async () => {
    // The failure this prevents: someone fixes a typo in a migration that already
    // ran here, and it then silently diverges from every database that applied the
    // original. Applied migrations are immutable; a change means a new file.
    await writeFile(
      path.join(fixture.directory, FIXTURE_MIGRATION),
      `CREATE TABLE ${FIXTURE_TABLE} (id integer PRIMARY KEY, added_later text)`,
    );

    const files = await readMigrationFiles(fixture.directory);

    await expect(withClient((client) => applyMigrations(client, files))).rejects.toThrow(
      MigrationChecksumMismatchError,
    );
  });

  it('names the offending file, so the fix is obvious', async () => {
    const files = await readMigrationFiles(fixture.directory);
    await expect(withClient((client) => applyMigrations(client, files))).rejects.toThrow(
      new RegExp(FIXTURE_MIGRATION),
    );
  });
});
