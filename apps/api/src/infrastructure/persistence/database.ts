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

export function createDatabase(environment: Environment): Database {
  const pool = new Pool({
    connectionString: environment.DATABASE_URL,
    max: environment.DATABASE_MAX_POOL_SIZE,
    statement_timeout: environment.DATABASE_STATEMENT_TIMEOUT_MILLISECONDS,
    application_name: 'payment-gateway',
  });
  return new Database(pool);
}
