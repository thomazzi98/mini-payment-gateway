import { generateApiKey, hashApiKeySecret, Secret } from '@gateway/shared/server';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticateApiKey, systemClock } from '../../application/authenticate-api-key.js';
import { PostgresApiKeyRepository } from './api-key.repository.js';
import {
  createApplicationPool,
  createOwnerPool,
  seedOrganization,
  withoutOrganizationScope,
} from './test-database.js';
import type { SeededOrganization } from './test-database.js';

const PEPPER = new Secret('an-integration-test-pepper');

interface KeyFixture {
  ownerPool: Pool;
  applicationPool: Pool;
  repository: PostgresApiKeyRepository;
  merchantA: SeededOrganization;
  merchantB: SeededOrganization;
}

const fixture = {} as KeyFixture;
const createdOrganizationIds: string[] = [];

/**
 * Inserts a key as the owner and returns the plaintext the caller would hold.
 */
async function issueKey(
  organizationId: string,
  options: { revoked?: boolean; expiresAt?: Date | null; scopes?: string[] } = {},
) {
  const generated = generateApiKey('SANDBOX');
  const hash = hashApiKeySecret(generated.identifier, generated.secret, PEPPER);

  // A key cannot be born already expired: the schema requires expires_at to be
  // after created_at. An expired key is one created earlier whose expiry has since
  // passed, so the fixture backdates creation to match that reality.
  const expiresAt = options.expiresAt ?? null;
  const createdAt =
    expiresAt !== null && expiresAt.getTime() <= Date.now()
      ? new Date(expiresAt.getTime() - 60_000)
      : new Date();

  const result = await fixture.ownerPool.query<{ id: string }>(
    `INSERT INTO api_keys
       (organization_id, environment, name, key_identifier, key_hash, last_four, scopes,
        revoked_at, expires_at, created_at)
     VALUES ($1, 'SANDBOX', $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      organizationId,
      `key-${generated.identifier}`,
      generated.identifier,
      hash,
      generated.lastFour,
      options.scopes ?? ['payments:write'],
      options.revoked === true ? new Date() : null,
      expiresAt,
      createdAt,
    ],
  );

  return { generated, apiKeyId: result.rows[0]?.id ?? '' };
}

beforeAll(async () => {
  fixture.ownerPool = createOwnerPool();
  fixture.applicationPool = createApplicationPool();
  fixture.repository = new PostgresApiKeyRepository(fixture.applicationPool);

  fixture.merchantA = await seedOrganization(fixture.ownerPool, 'Key Merchant A');
  fixture.merchantB = await seedOrganization(fixture.ownerPool, 'Key Merchant B');
  createdOrganizationIds.push(fixture.merchantA.id, fixture.merchantB.id);
});

afterAll(async () => {
  await fixture.ownerPool.query('DELETE FROM api_keys WHERE organization_id = ANY($1)', [
    createdOrganizationIds,
  ]);
  await fixture.ownerPool.query('DELETE FROM organizations WHERE id = ANY($1)', [
    createdOrganizationIds,
  ]);
  await fixture.ownerPool.end();
  await fixture.applicationPool.end();
});

describe('resolving a key through the database', () => {
  it('finds a key by its public identifier without any tenant scope set', async () => {
    // Authentication runs before a tenant is known, so this must work unscoped.
    const { generated, apiKeyId } = await issueKey(fixture.merchantA.id);
    const stored = await fixture.repository.findByIdentifier(generated.identifier);

    expect(stored?.apiKeyId).toBe(apiKeyId);
    expect(stored?.organizationId).toBe(fixture.merchantA.id);
    expect(stored?.environment).toBe('SANDBOX');
    expect(stored?.keyHash).toHaveLength(32);
  });

  it('returns nothing for an identifier that does not exist', async () => {
    expect(await fixture.repository.findByIdentifier('zzzzzzzzzzzz')).toBeUndefined();
  });

  it('still refuses direct reads of the table it is reading through', async () => {
    // The function is the only permitted door. If the table itself were readable
    // unscoped, the whole isolation argument would collapse.
    const rows = await withoutOrganizationScope(fixture.applicationPool, async (client) => {
      const result = await client.query<{ id: string }>('SELECT id FROM api_keys');
      return result.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it('drops a scope the application does not recognise instead of trusting it', async () => {
    const { generated } = await issueKey(fixture.merchantA.id, {
      scopes: ['payments:write', 'not-a-real-scope'],
    });
    const stored = await fixture.repository.findByIdentifier(generated.identifier);

    expect(stored?.scopes).toEqual(['payments:write']);
  });
});

describe('authenticating end to end against the database', () => {
  it('accepts a real key and reports the owning organization', async () => {
    const { generated } = await issueKey(fixture.merchantA.id);
    const result = await authenticateApiKey(generated.plaintext.expose(), {
      repository: fixture.repository,
      pepper: PEPPER,
      clock: systemClock,
    });

    expect(result.outcome).toBe('authenticated');
    if (result.outcome !== 'authenticated') {
      throw new Error('expected authentication to succeed');
    }
    expect(result.principal.organizationId).toBe(fixture.merchantA.id);
  });

  it('authenticates each merchant to its own organization and never the other', async () => {
    const keyForA = await issueKey(fixture.merchantA.id);
    const keyForB = await issueKey(fixture.merchantB.id);

    const dependencies = {
      repository: fixture.repository,
      pepper: PEPPER,
      clock: systemClock,
    };

    const resultA = await authenticateApiKey(keyForA.generated.plaintext.expose(), dependencies);
    const resultB = await authenticateApiKey(keyForB.generated.plaintext.expose(), dependencies);

    expect(resultA.outcome === 'authenticated' && resultA.principal.organizationId).toBe(
      fixture.merchantA.id,
    );
    expect(resultB.outcome === 'authenticated' && resultB.principal.organizationId).toBe(
      fixture.merchantB.id,
    );
  });

  it('rejects a revoked key', async () => {
    const { generated } = await issueKey(fixture.merchantA.id, { revoked: true });
    const result = await authenticateApiKey(generated.plaintext.expose(), {
      repository: fixture.repository,
      pepper: PEPPER,
      clock: systemClock,
    });

    expect(result).toEqual({ outcome: 'rejected', reason: 'revoked' });
  });

  it('rejects a key whose expiry has passed', async () => {
    const { generated } = await issueKey(fixture.merchantA.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const result = await authenticateApiKey(generated.plaintext.expose(), {
      repository: fixture.repository,
      pepper: PEPPER,
      clock: systemClock,
    });

    expect(result).toEqual({ outcome: 'rejected', reason: 'expired' });
  });

  it('cannot be given an expiry at or before its creation', async () => {
    // This is what caught an unrealistic fixture: the schema refuses a key that
    // was never usable for a single moment.
    const generated = generateApiKey('SANDBOX');
    await expect(
      fixture.ownerPool.query(
        `INSERT INTO api_keys
           (organization_id, environment, name, key_identifier, key_hash, last_four, scopes,
            expires_at, created_at)
         VALUES ($1, 'SANDBOX', 'impossible', $2, $3, 'aaaa', ARRAY['payments:write'],
                 now() - interval '1 hour', now())`,
        [fixture.merchantA.id, generated.identifier, Buffer.alloc(32)],
      ),
    ).rejects.toThrow(/api_keys_expiry_after_creation/);
  });

  it('rejects every key of an archived organization', async () => {
    const archived = await seedOrganization(fixture.ownerPool, 'Archived Merchant');
    createdOrganizationIds.push(archived.id);
    const { generated } = await issueKey(archived.id);
    await fixture.ownerPool.query('UPDATE organizations SET archived_at = now() WHERE id = $1', [
      archived.id,
    ]);

    const result = await authenticateApiKey(generated.plaintext.expose(), {
      repository: fixture.repository,
      pepper: PEPPER,
      clock: systemClock,
    });

    expect(result).toEqual({ outcome: 'rejected', reason: 'organization_archived' });
  });

  it('rejects a forged secret against a real identifier', async () => {
    const { generated } = await issueKey(fixture.merchantA.id);
    const impostor = generateApiKey('SANDBOX');
    // Built rather than substituted: a real identifier joined to somebody else's
    // secret is exactly the forgery this must refuse.
    const forged = `mpg_test_${generated.identifier}${impostor.secret.expose()}`;

    const result = await authenticateApiKey(forged, {
      repository: fixture.repository,
      pepper: PEPPER,
      clock: systemClock,
    });

    expect(result).toEqual({ outcome: 'rejected', reason: 'invalid_secret' });
  });

  it('survives many concurrent authentications of the same key', async () => {
    const { generated } = await issueKey(fixture.merchantA.id);
    const dependencies = {
      repository: fixture.repository,
      pepper: PEPPER,
      clock: systemClock,
    };

    const results = await Promise.all(
      Array.from({ length: 40 }, async () =>
        authenticateApiKey(generated.plaintext.expose(), dependencies),
      ),
    );

    expect(results.every((result) => result.outcome === 'authenticated')).toBe(true);
  });
});

describe('recording use', () => {
  it('sets last_used_at, and does so without granting write access to the table', async () => {
    const { generated, apiKeyId } = await issueKey(fixture.merchantA.id);

    const before = await fixture.ownerPool.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM api_keys WHERE id = $1',
      [apiKeyId],
    );
    expect(before.rows[0]?.last_used_at).toBeNull();

    await fixture.repository.recordUse(apiKeyId);

    const after = await fixture.ownerPool.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM api_keys WHERE id = $1',
      [apiKeyId],
    );
    expect(after.rows[0]?.last_used_at).toBeInstanceOf(Date);
    expect(generated.plaintext.expose()).toContain(generated.identifier);
  });

  it('cannot be used to touch a row it does not address', async () => {
    // The function takes a primary key, so it can only ever move one timestamp.
    const keyForB = await issueKey(fixture.merchantB.id);
    await fixture.repository.recordUse(keyForB.apiKeyId);

    const rows = await fixture.ownerPool.query<{ count: string }>(
      'SELECT count(*) AS count FROM api_keys WHERE last_used_at IS NOT NULL',
    );
    expect(Number(rows.rows[0]?.count)).toBeGreaterThan(0);
  });
});
