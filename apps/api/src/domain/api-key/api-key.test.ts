import { describe, expect, it } from 'vitest';
import {
  API_KEY_SCOPES,
  hasScope,
  isApiKeyScope,
  lifecycleRejection,
  missingScopes,
} from './api-key.js';
import type { ApiKeyPrincipal } from './api-key.js';

const principal: ApiKeyPrincipal = {
  apiKeyId: 'api-key-1',
  organizationId: 'organization-1',
  environment: 'SANDBOX',
  scopes: ['payments:read', 'payments:write'],
};

describe('the scope vocabulary', () => {
  it('is a closed set', () => {
    // Pinned deliberately. Adding a scope is a decision about what a key may do,
    // so it should be a visible change here rather than an incidental one.
    expect([...API_KEY_SCOPES]).toEqual([
      'payments:read',
      'payments:write',
      'refunds:write',
      'providers:read',
      'providers:write',
      'webhooks:read',
      'webhooks:write',
    ]);
  });

  it('recognises only members of that set', () => {
    for (const scope of API_KEY_SCOPES) {
      expect(isApiKeyScope(scope)).toBe(true);
    }
    for (const impostor of [
      'payments:admin',
      'PAYMENTS:READ',
      'payments',
      '',
      undefined,
      null,
      42,
    ]) {
      expect(isApiKeyScope(impostor)).toBe(false);
    }
  });
});

describe('checking scopes', () => {
  it('answers for a single scope', () => {
    expect(hasScope(principal, 'payments:read')).toBe(true);
    expect(hasScope(principal, 'refunds:write')).toBe(false);
  });

  it('reports every missing scope, not just the first', () => {
    expect(missingScopes(principal, ['payments:read', 'payments:write'])).toEqual([]);
    expect(missingScopes(principal, ['refunds:write', 'providers:write'])).toEqual([
      'refunds:write',
      'providers:write',
    ]);
  });

  it('treats an empty requirement as satisfied', () => {
    expect(missingScopes(principal, [])).toEqual([]);
  });
});

describe('lifecycle', () => {
  const now = new Date('2026-09-08T12:00:00.000Z');
  const usable = { revokedAt: null, expiresAt: null, organizationArchivedAt: null };

  it('permits a key with nothing set against it', () => {
    expect(lifecycleRejection(usable, now)).toBeUndefined();
  });

  it('refuses a revoked key', () => {
    expect(lifecycleRejection({ ...usable, revokedAt: new Date('2026-09-01') }, now)).toBe(
      'revoked',
    );
  });

  it('refuses an expired key and permits one that has not expired yet', () => {
    expect(lifecycleRejection({ ...usable, expiresAt: new Date('2026-09-07') }, now)).toBe(
      'expired',
    );
    expect(
      lifecycleRejection({ ...usable, expiresAt: new Date('2026-09-09') }, now),
    ).toBeUndefined();
  });

  it('treats the exact expiry instant as expired, so the boundary is not ambiguous', () => {
    expect(lifecycleRejection({ ...usable, expiresAt: now }, now)).toBe('expired');
  });

  it('refuses a key whose organization is archived', () => {
    expect(
      lifecycleRejection({ ...usable, organizationArchivedAt: new Date('2026-09-01') }, now),
    ).toBe('organization_archived');
  });

  it('reports revocation ahead of expiry when both apply', () => {
    // Both are terminal, but revocation is the deliberate act and is the more
    // useful thing to see in an audit log.
    expect(
      lifecycleRejection(
        {
          revokedAt: new Date('2026-09-01'),
          expiresAt: new Date('2026-09-02'),
          organizationArchivedAt: null,
        },
        now,
      ),
    ).toBe('revoked');
  });

  it('ignores a revocation scheduled in the future', () => {
    expect(
      lifecycleRejection({ ...usable, revokedAt: new Date('2026-09-09') }, now),
    ).toBeUndefined();
  });
});
