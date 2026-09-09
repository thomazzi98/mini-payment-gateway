import type { Pool } from 'pg';
import type { ApiKeyScope, Environment } from '../../domain/api-key/api-key.js';
import { isApiKeyScope } from '../../domain/api-key/api-key.js';
import type { ApiKeyRepository, StoredApiKey } from '../../application/ports/api-key.repository.js';

interface AuthenticateApiKeyRow {
  readonly api_key_id: string;
  readonly organization_id: string;
  readonly environment: Environment;
  readonly key_hash: Buffer;
  readonly scopes: string[];
  readonly revoked_at: Date | null;
  readonly expires_at: Date | null;
  readonly organization_archived_at: Date | null;
}

/**
 * Reads api keys through the two SECURITY DEFINER functions rather than the table.
 *
 * The table is closed to the application role by row level security, and it has to
 * be: resolving a key is the one lookup that cannot already know its tenant,
 * because the organization is what the lookup produces. Confining that to two
 * named functions keeps the exception small and reviewable, instead of granting
 * the application blanket access to every key in the system.
 */
export class PostgresApiKeyRepository implements ApiKeyRepository {
  public constructor(private readonly pool: Pool) {}

  public async findByIdentifier(identifier: string): Promise<StoredApiKey | undefined> {
    const result = await this.pool.query<AuthenticateApiKeyRow>(
      'SELECT * FROM authenticate_api_key($1)',
      [identifier],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }

    return {
      apiKeyId: row.api_key_id,
      organizationId: row.organization_id,
      environment: row.environment,
      keyHash: row.key_hash,
      // An unrecognised scope is dropped rather than trusted. A value that reached
      // the column before the enum knew about it must not silently grant anything.
      scopes: row.scopes.filter((scope): scope is ApiKeyScope => isApiKeyScope(scope)),
      revokedAt: row.revoked_at,
      expiresAt: row.expires_at,
      organizationArchivedAt: row.organization_archived_at,
    };
  }

  public async recordUse(apiKeyId: string): Promise<void> {
    await this.pool.query('SELECT record_api_key_use($1)', [apiKeyId]);
  }
}
