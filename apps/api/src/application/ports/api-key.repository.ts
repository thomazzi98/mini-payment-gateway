import type { ApiKeyScope, Environment } from '../../domain/api-key/api-key.js';

/**
 * What the authenticator needs to know about a stored key.
 *
 * It carries the hash, never a secret, and the caller compares in constant time.
 * A record existing says nothing about whether the key is usable; the lifecycle
 * fields decide that.
 */
export interface StoredApiKey {
  readonly apiKeyId: string;
  readonly organizationId: string;
  readonly environment: Environment;
  readonly keyHash: Buffer;
  readonly scopes: readonly ApiKeyScope[];
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly organizationArchivedAt: Date | null;
}

export interface ApiKeyRepository {
  /**
   * Resolves at most one key by its public identifier, which is unique.
   */
  findByIdentifier(identifier: string): Promise<StoredApiKey | undefined>;

  /**
   * Records that a key was used. Deliberately fire-and-forget at the call site:
   * a failure to update a timestamp must never fail an authenticated request.
   */
  recordUse(apiKeyId: string): Promise<void>;
}
