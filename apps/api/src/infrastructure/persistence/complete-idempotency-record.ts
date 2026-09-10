import type { PoolClient } from 'pg';

/**
 * Closes a claim with the response it is to replay.
 *
 * Shared by every writer that settles a payment, because the stored status and
 * body are what a retry receives: two implementations would be two chances for a
 * replay to answer with something the caller never got.
 *
 * The caller supplies the transaction, so the claim always closes with whatever
 * made it closable.
 */
export async function completeIdempotencyRecord(
  client: PoolClient,
  command: {
    readonly organizationId: string;
    readonly environment: 'SANDBOX' | 'PRODUCTION';
    readonly idempotencyKey: string;
    readonly responseStatus: number;
    readonly responseBody: unknown;
  },
): Promise<void> {
  await client.query(
    `UPDATE idempotency_records
        SET state = 'completed', response_status = $4, response_body = $5,
            completed_at = now()
      WHERE organization_id = $1 AND environment = $2 AND idempotency_key = $3`,
    [
      command.organizationId,
      command.environment,
      command.idempotencyKey,
      command.responseStatus,
      JSON.stringify(command.responseBody),
    ],
  );
}
