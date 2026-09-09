import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asOrganization,
  createApplicationPool,
  createOwnerPool,
  seedApiKey,
  seedOrganization,
  withoutOrganizationScope,
} from './test-database.js';
import type { SeededOrganization } from './test-database.js';

/**
 * These tests bypass the application entirely and talk to PostgreSQL as the role
 * the api uses. Nothing here exercises a repository or a route, so a passing run
 * says the database refuses cross-tenant access on its own — not that our code
 * remembered to add a WHERE clause.
 */

interface IsolationFixture {
  ownerPool: Pool;
  applicationPool: Pool;
  merchantA: SeededOrganization;
  merchantB: SeededOrganization;
}

const fixture = {} as IsolationFixture;

beforeAll(async () => {
  fixture.ownerPool = createOwnerPool();
  fixture.applicationPool = createApplicationPool();

  fixture.merchantA = await seedOrganization(fixture.ownerPool, 'Merchant A');
  fixture.merchantB = await seedOrganization(fixture.ownerPool, 'Merchant B');
  await seedApiKey(fixture.ownerPool, fixture.merchantA.id);
  await seedApiKey(fixture.ownerPool, fixture.merchantB.id);
});

afterAll(async () => {
  await fixture.ownerPool.query('DELETE FROM api_keys WHERE organization_id = ANY($1)', [
    [fixture.merchantA.id, fixture.merchantB.id],
  ]);
  await fixture.ownerPool.query('DELETE FROM organizations WHERE id = ANY($1)', [
    [fixture.merchantA.id, fixture.merchantB.id],
  ]);
  await fixture.ownerPool.end();
  await fixture.applicationPool.end();
});

describe('the application role', () => {
  it('holds no privilege that would make row level security advisory', async () => {
    const result = await fixture.ownerPool.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
         FROM pg_roles WHERE rolname = 'payment_gateway_application'`,
    );

    expect(result.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });

  it('cannot alter the schema, so an injection foothold cannot drop a policy', async () => {
    await expect(
      withoutOrganizationScope(fixture.applicationPool, (client) =>
        client.query('CREATE TABLE should_not_exist (id integer)'),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot read the migrator’s bookkeeping', async () => {
    await expect(
      withoutOrganizationScope(fixture.applicationPool, (client) =>
        client.query('SELECT count(*) FROM schema_migrations'),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('reading across tenants', () => {
  it('sees only its own organization', async () => {
    const rows = await asOrganization(
      fixture.applicationPool,
      fixture.merchantA.id,
      async (client) => {
        const result = await client.query<{ slug: string }>('SELECT slug FROM organizations');
        return result.rows;
      },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe(fixture.merchantA.slug);
  });

  it('returns nothing when another tenant is requested by primary key', async () => {
    // The most direct attack: the caller already knows the identifier.
    const rows = await asOrganization(
      fixture.applicationPool,
      fixture.merchantA.id,
      async (client) => {
        const result = await client.query<{ id: string }>(
          'SELECT id FROM organizations WHERE id = $1',
          [fixture.merchantB.id],
        );
        return result.rows;
      },
    );

    expect(rows).toHaveLength(0);
  });

  it('returns nothing for another tenant’s api keys', async () => {
    const rows = await asOrganization(
      fixture.applicationPool,
      fixture.merchantA.id,
      async (client) => {
        const result = await client.query<{ id: string }>(
          'SELECT id FROM api_keys WHERE organization_id = $1',
          [fixture.merchantB.id],
        );
        return result.rows;
      },
    );

    expect(rows).toHaveLength(0);
  });

  it('fails closed when no tenant scope has been set', async () => {
    // Forgetting to set the scope must yield an empty result, never everything.
    const rows = await withoutOrganizationScope(fixture.applicationPool, async (client) => {
      const result = await client.query<{ id: string }>('SELECT id FROM organizations');
      return result.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it('does not leak through an aggregate, which ignores row visibility less obviously', async () => {
    const total = await asOrganization(
      fixture.applicationPool,
      fixture.merchantA.id,
      async (client) => {
        const result = await client.query<{ count: string }>('SELECT count(*) FROM organizations');
        return Number(result.rows[0]?.count);
      },
    );

    expect(total).toBe(1);
  });
});

describe('writing across tenants', () => {
  it('updates nothing when it targets another tenant', async () => {
    const affected = await asOrganization(
      fixture.applicationPool,
      fixture.merchantA.id,
      async (client) => {
        const result = await client.query('UPDATE organizations SET name = $1 WHERE id = $2', [
          'hijacked',
          fixture.merchantB.id,
        ]);
        return result.rowCount;
      },
    );

    expect(affected).toBe(0);

    const unchanged = await fixture.ownerPool.query<{ name: string }>(
      'SELECT name FROM organizations WHERE id = $1',
      [fixture.merchantB.id],
    );
    expect(unchanged.rows[0]?.name).toBe('Merchant B');
  });

  it('deletes nothing when it targets another tenant', async () => {
    const affected = await asOrganization(
      fixture.applicationPool,
      fixture.merchantA.id,
      async (client) => {
        const result = await client.query('DELETE FROM api_keys WHERE organization_id = $1', [
          fixture.merchantB.id,
        ]);
        return result.rowCount;
      },
    );

    expect(affected).toBe(0);

    const survivors = await fixture.ownerPool.query(
      'SELECT id FROM api_keys WHERE organization_id = $1',
      [fixture.merchantB.id],
    );
    expect(survivors.rows).toHaveLength(1);
  });

  it('refuses an insert that would assign a row to another tenant', async () => {
    // WITH CHECK, not just USING: reading is filtered, but writing is rejected
    // outright, so a mistake surfaces as an error instead of a silent no-op.
    await expect(
      asOrganization(fixture.applicationPool, fixture.merchantA.id, (client) =>
        client.query(
          `INSERT INTO api_keys
             (organization_id, environment, name, key_identifier, key_hash, last_four, scopes)
           VALUES ($1, 'SANDBOX', 'stolen', 'zzzzzzzzzzzz',
                   decode(repeat('61', 32), 'hex'), 'zzzz', ARRAY['payments:write'])`,
          [fixture.merchantB.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses to move one of its own rows to another tenant', async () => {
    await expect(
      asOrganization(fixture.applicationPool, fixture.merchantA.id, (client) =>
        client.query('UPDATE api_keys SET organization_id = $1 WHERE organization_id = $2', [
          fixture.merchantB.id,
          fixture.merchantA.id,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('the tenant-scoped table registry', () => {
  it('has row level security enabled on every table it lists', async () => {
    const result = await fixture.ownerPool.query<{ table_name: string; relrowsecurity: boolean }>(
      `SELECT registry.table_name, class.relrowsecurity
         FROM tenant_scoped_tables AS registry
         JOIN pg_class AS class ON class.relname = registry.table_name
        WHERE class.relnamespace = 'public'::regnamespace`,
    );

    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.table_name} must have row level security`).toBe(true);
    }
  });

  it('has a policy for every table it lists', async () => {
    const result = await fixture.ownerPool.query<{ table_name: string; policy_count: string }>(
      `SELECT registry.table_name,
              count(policies.policyname) AS policy_count
         FROM tenant_scoped_tables AS registry
         LEFT JOIN pg_policies AS policies
           ON policies.tablename = registry.table_name AND policies.schemaname = 'public'
        GROUP BY registry.table_name`,
    );

    for (const row of result.rows) {
      expect(Number(row.policy_count), `${row.table_name} must have a policy`).toBeGreaterThan(0);
    }
  });

  it('lists every table that carries an organization_id', async () => {
    // The mistake this catches: adding a tenant-owned table months from now and
    // forgetting the policy. The column exists, so the table belongs in the
    // registry, and the two tests above then force it to have RLS.
    const result = await fixture.ownerPool.query<{ table_name: string }>(
      `SELECT columns.table_name
         FROM information_schema.columns AS columns
        WHERE columns.table_schema = 'public'
          AND columns.column_name = 'organization_id'
          AND columns.table_name NOT IN (SELECT table_name FROM tenant_scoped_tables)`,
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([]);
  });
});
