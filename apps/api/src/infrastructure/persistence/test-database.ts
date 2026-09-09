import { Pool } from 'pg';
import type { PoolClient } from 'pg';

/**
 * Connections used by integration tests.
 *
 * Two roles, on purpose. The owner seeds fixtures and inspects results because it
 * owns the tables and therefore bypasses row level security. The application role
 * is the one under test: it owns nothing and holds no BYPASSRLS, so every policy
 * applies to it exactly as it does in production.
 *
 * A test that seeded and asserted through the same privileged connection would
 * prove nothing about isolation.
 */

function requiredVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required to run integration tests. They run inside the compose network: use "docker compose --profile test run --rm test".`,
    );
  }
  return value;
}

export function createOwnerPool(): Pool {
  return new Pool({
    connectionString: requiredVariable('OWNER_DATABASE_URL'),
    max: 4,
    application_name: 'integration-test-owner',
  });
}

export function createApplicationPool(): Pool {
  return new Pool({
    connectionString: requiredVariable('DATABASE_URL'),
    max: 4,
    application_name: 'integration-test-application',
  });
}

/**
 * Runs a query as the application role with a tenant scope, exactly as the api does.
 */
export async function asOrganization<Result>(
  pool: Pool,
  organizationId: string,
  work: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', organizationId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs a query as the application role with no tenant scope set at all.
 */
export async function withoutOrganizationScope<Result>(
  pool: Pool,
  work: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

export interface SeededOrganization {
  readonly id: string;
  readonly publicId: string;
  readonly slug: string;
}

const nextSequenceNumber = (() => {
  let counter = 0;
  return () => {
    counter += 1;
    return counter;
  };
})();

function uniqueSuffix(): string {
  const random = Math.floor(Math.random() * 0xff_ff_ff)
    .toString(32)
    .padStart(5, '0');
  return `${nextSequenceNumber().toString(32).padStart(3, '0')}${random}`;
}

/**
 * Builds a valid 26-character Crockford base32 body without pulling in the generator.
 */
function publicIdentifierBody(): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let body = '';
  while (body.length < 26) {
    body += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return body;
}

/**
 * A valid public identifier with the given prefix. Built here rather than
 * imported so the fixtures do not depend on the generator they help test.
 */
export function publicIdentifierFor(prefix: string): string {
  return `${prefix}_${publicIdentifierBody()}`;
}

export async function seedOrganization(pool: Pool, label: string): Promise<SeededOrganization> {
  const slug = `${label}-${uniqueSuffix()}`.toLowerCase().replaceAll(/[^a-z0-9-]/g, '');
  const publicId = `org_${publicIdentifierBody()}`;

  const result = await pool.query<{ id: string }>(
    'INSERT INTO organizations (public_id, name, slug) VALUES ($1, $2, $3) RETURNING id',
    [publicId, label, slug],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('seeding an organization returned no row');
  }
  return { id: row.id, publicId, slug };
}

export async function seedApiKey(
  pool: Pool,
  organizationId: string,
  options: { environment?: 'SANDBOX' | 'PRODUCTION'; scopes?: string[] } = {},
): Promise<{ id: string; identifier: string }> {
  const identifier = uniqueSuffix().padEnd(12, '0').slice(0, 12);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO api_keys
       (organization_id, environment, name, key_identifier, key_hash, last_four, scopes)
     VALUES ($1, $2, $3, $4, decode(repeat('61', 32), 'hex'), 'aaaa', $5)
     RETURNING id`,
    [
      organizationId,
      options.environment ?? 'SANDBOX',
      `key-${identifier}`,
      identifier,
      options.scopes ?? ['payments:write'],
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('seeding an api key returned no row');
  }
  return { id: row.id, identifier };
}
