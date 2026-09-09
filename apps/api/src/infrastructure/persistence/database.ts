import { Pool } from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Environment } from '../configuration/environment.js';

export interface DatabaseHealth {
  readonly isReachable: boolean;
  readonly durationMilliseconds: number;
  readonly error?: string;
}

export class Database {
  public constructor(private readonly pool: Pool) {}

  public async query<Row extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Row[]> {
    const result = await this.pool.query<Row>(text, values as unknown[]);
    return result.rows;
  }

  /**
   * Every write that must be atomic goes through here. Callers receive a client
   * rather than the pool, so a transaction cannot accidentally span connections.
   */
  public async withTransaction<Result>(
    work: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
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
   * The only way tenant data is read or written.
   *
   * set_config with is_local = true scopes the setting to this transaction, so it
   * is discarded on commit or rollback and cannot survive on a pooled connection
   * into somebody else's request. Row level security then does the rest: a query
   * that forgets its filter returns nothing rather than another merchant's rows.
   */
  public async withOrganizationScope<Result>(
    organizationId: string,
    work: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    return this.withTransaction(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        organizationId,
      ]);
      return work(client);
    });
  }

  public async checkHealth(): Promise<DatabaseHealth> {
    const startedAt = process.hrtime.bigint();
    try {
      await this.pool.query('SELECT 1');
      return {
        isReachable: true,
        durationMilliseconds: elapsedMilliseconds(startedAt),
      };
    } catch (error) {
      return {
        isReachable: false,
        durationMilliseconds: elapsedMilliseconds(startedAt),
        error: error instanceof Error ? error.message : 'unknown database error',
      };
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

function elapsedMilliseconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

/**
 * The one pool this process owns.
 *
 * Built here and shared by everything that talks to Postgres, so
 * DATABASE_MAX_POOL_SIZE means what it says and the statement timeout applies to
 * every query rather than only the ones that happened to come through Database.
 * A second pool would silently double the connection count against a server that
 * has its own max_connections.
 */
export function createConnectionPool(environment: Environment): Pool {
  return new Pool({
    connectionString: environment.DATABASE_URL,
    max: environment.DATABASE_MAX_POOL_SIZE,
    statement_timeout: environment.DATABASE_STATEMENT_TIMEOUT_MILLISECONDS,
    application_name: 'payment-gateway',
  });
}
