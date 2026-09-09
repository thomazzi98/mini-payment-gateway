import { generateApiKey, hashApiKeySecret, Secret } from '@gateway/shared/server';
import type { GeneratedApiKey } from '@gateway/shared/server';
import { describe, expect, it } from 'vitest';
import { missingScopes } from '../domain/api-key/api-key.js';
import type { ApiKeyScope } from '../domain/api-key/api-key.js';
import { authenticateApiKey } from './authenticate-api-key.js';
import type { Clock } from './authenticate-api-key.js';
import type { ApiKeyRepository, StoredApiKey } from './ports/api-key.repository.js';

const PEPPER = new Secret('a-pepper-that-lives-outside-the-database');
const NOW = new Date('2026-09-08T12:00:00.000Z');
const fixedClock: Clock = { now: () => NOW };

interface Fixture {
  readonly generated: GeneratedApiKey;
  readonly repository: ApiKeyRepository;
}

function fixtureFor(overrides: Partial<StoredApiKey> = {}): Fixture {
  const generated = generateApiKey('SANDBOX');
  const stored: StoredApiKey = {
    apiKeyId: 'api-key-1',
    organizationId: 'organization-1',
    environment: 'SANDBOX',
    keyHash: hashApiKeySecret(generated.identifier, generated.secret, PEPPER),
    scopes: ['payments:write', 'payments:read'],
    revokedAt: null,
    expiresAt: null,
    organizationArchivedAt: null,
    ...overrides,
  };

  const repository: ApiKeyRepository = {
    findByIdentifier: (identifier) =>
      Promise.resolve(identifier === generated.identifier ? stored : undefined),
    recordUse: () => Promise.resolve(),
  };

  return { generated, repository };
}

async function authenticate(fixture: Fixture, presented?: string) {
  return authenticateApiKey(presented ?? fixture.generated.plaintext.expose(), {
    repository: fixture.repository,
    pepper: PEPPER,
    clock: fixedClock,
  });
}

describe('authenticating an api key', () => {
  it('accepts a valid key and yields its principal', async () => {
    const fixture = fixtureFor();
    const result = await authenticate(fixture);

    expect(result.outcome).toBe('authenticated');
    if (result.outcome !== 'authenticated') {
      throw new Error('expected authentication to succeed');
    }
    expect(result.principal.organizationId).toBe('organization-1');
    expect(result.principal.environment).toBe('SANDBOX');
    expect(result.principal.scopes).toContain('payments:write');
  });

  it('rejects a malformed key without consulting the repository', async () => {
    let wasConsulted = false;
    const result = await authenticateApiKey('not-a-key', {
      repository: {
        findByIdentifier: () => {
          wasConsulted = true;
          return Promise.resolve(undefined);
        },
        recordUse: () => Promise.resolve(),
      },
      pepper: PEPPER,
      clock: fixedClock,
    });

    expect(result).toEqual({ outcome: 'rejected', reason: 'malformed_key' });
    expect(wasConsulted).toBe(false);
  });

  it('rejects an unknown key', async () => {
    const fixture = fixtureFor();
    const stranger = generateApiKey('SANDBOX').plaintext.expose();
    expect(await authenticate(fixture, stranger)).toEqual({
      outcome: 'rejected',
      reason: 'unknown_key',
    });
  });

  it('rejects a valid identifier presented with the wrong secret', async () => {
    const fixture = fixtureFor();
    const impostor = generateApiKey('SANDBOX');
    const forged = `mpg_test_${fixture.generated.identifier}${impostor.secret.expose()}`;

    expect(await authenticate(fixture, forged)).toEqual({
      outcome: 'rejected',
      reason: 'invalid_secret',
    });
  });

  it('rejects a revoked key', async () => {
    const fixture = fixtureFor({ revokedAt: new Date('2026-09-01T00:00:00.000Z') });
    expect(await authenticate(fixture)).toEqual({ outcome: 'rejected', reason: 'revoked' });
  });

  it('rejects an expired key, and accepts one whose expiry is still ahead', async () => {
    const expired = fixtureFor({ expiresAt: new Date('2026-09-08T11:59:59.000Z') });
    expect(await authenticate(expired)).toEqual({ outcome: 'rejected', reason: 'expired' });

    const stillValid = fixtureFor({ expiresAt: new Date('2026-09-08T12:00:01.000Z') });
    const stillValidResult = await authenticate(stillValid);
    expect(stillValidResult.outcome).toBe('authenticated');
  });

  it('treats an expiry exactly at the current instant as expired', async () => {
    const fixture = fixtureFor({ expiresAt: NOW });
    expect(await authenticate(fixture)).toEqual({ outcome: 'rejected', reason: 'expired' });
  });

  it('rejects a key whose organization has been archived', async () => {
    const fixture = fixtureFor({ organizationArchivedAt: new Date('2026-09-01T00:00:00.000Z') });
    expect(await authenticate(fixture)).toEqual({
      outcome: 'rejected',
      reason: 'organization_archived',
    });
  });

  it('checks the secret before the lifecycle, so a wrong secret cannot confirm a real key', async () => {
    // Answering "revoked" to somebody holding the wrong secret would tell them
    // the identifier is real. They must get the same answer either way.
    const fixture = fixtureFor({ revokedAt: new Date('2026-09-01T00:00:00.000Z') });
    const impostor = generateApiKey('SANDBOX');
    const forged = `mpg_test_${fixture.generated.identifier}${impostor.secret.expose()}`;

    expect(await authenticate(fixture, forged)).toEqual({
      outcome: 'rejected',
      reason: 'invalid_secret',
    });
  });

  it('rejects a rotated key once the old one is revoked while the new one works', async () => {
    const rotatedOut = fixtureFor({ revokedAt: new Date('2026-09-07T00:00:00.000Z') });
    const rotatedIn = fixtureFor();

    expect(await authenticate(rotatedOut)).toEqual({ outcome: 'rejected', reason: 'revoked' });
    const rotatedInResult = await authenticate(rotatedIn);
    expect(rotatedInResult.outcome).toBe('authenticated');
  });

  it('handles concurrent authentications of the same key independently', async () => {
    const fixture = fixtureFor();
    const results = await Promise.all(
      Array.from({ length: 50 }, async () => authenticate(fixture)),
    );

    expect(results.every((result) => result.outcome === 'authenticated')).toBe(true);
  });

  it('never puts the presented secret into the result', async () => {
    const fixture = fixtureFor();
    const serialized = JSON.stringify(await authenticate(fixture));

    expect(serialized).not.toContain(fixture.generated.secret.expose());
    expect(serialized).not.toContain(fixture.generated.plaintext.expose());
  });
});

describe('scope checks', () => {
  const principal = {
    apiKeyId: 'api-key-1',
    organizationId: 'organization-1',
    environment: 'SANDBOX',
    scopes: ['payments:read'] as ApiKeyScope[],
  } as const;

  it('reports the scopes a principal is missing', () => {
    expect(missingScopes(principal, ['payments:read'])).toEqual([]);
    expect(missingScopes(principal, ['payments:write'])).toEqual(['payments:write']);
    expect(missingScopes(principal, ['payments:read', 'refunds:write'])).toEqual(['refunds:write']);
  });
});
