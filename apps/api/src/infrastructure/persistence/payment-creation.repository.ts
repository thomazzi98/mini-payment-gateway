import type { Pool, PoolClient } from 'pg';
import { generatePublicIdentifier } from '@gateway/shared';
import {
  decideForExistingRecord,
  fingerprintRequest,
} from '../../domain/idempotency/idempotency.js';
import type { IdempotencyDecision } from '../../domain/idempotency/idempotency.js';

export interface CreatePaymentCommand {
  readonly organizationId: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly merchantReference: string;
  readonly paymentMethod: 'pix' | 'card' | 'boleto';
  readonly currency: string;
  readonly expectedAmountMinor: bigint;
  readonly idempotencyKey: string;
  readonly requestPath: string;
  /**
   * The request as the merchant sent it, used only for the fingerprint.
   */
  readonly requestBody: unknown;
}

export type CreatePaymentResult =
  | { readonly kind: 'created'; readonly paymentId: string; readonly publicId: string }
  | { readonly kind: 'replayed'; readonly responseStatus: number; readonly responseBody: unknown }
  | { readonly kind: 'in_flight' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'duplicate_merchant_reference' };

interface ExistingRecordRow {
  readonly request_fingerprint: Buffer;
  readonly request_path: string;
  readonly state: 'in_flight' | 'completed';
  readonly response_status: number | null;
  readonly response_body: unknown;
}

const UNIQUE_VIOLATION = '23505';

function isUniqueViolationOn(error: unknown, constraintName: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION &&
    ((error as { constraint?: string }).constraint === constraintName ||
      ((error as { message?: string }).message ?? '').includes(constraintName))
  );
}

/**
 * Creates a payment at most once per idempotency key.
 *
 * The claim, the payment and the completion all happen in one transaction. That
 * is what makes the guarantee real: there is no window in which a key is claimed
 * but its payment is missing, and a crash rolls the whole thing back so the
 * merchant may simply retry.
 *
 * Concurrency is handled by the unique index rather than by checking first. Two
 * simultaneous requests both reach the INSERT; PostgreSQL blocks the second until
 * the first commits, and it then sees the conflict and replays. An application
 * level "does this key exist" check could not offer that, because another process
 * fits between its read and its write.
 */
export class PaymentCreationRepository {
  public constructor(private readonly pool: Pool) {}

  private async createWithinTransaction(
    client: PoolClient,
    command: CreatePaymentCommand,
  ): Promise<CreatePaymentResult> {
    const fingerprint = fingerprintRequest(command.requestPath, command.requestBody);

    const claim = await client.query<{ id: string }>(
      `INSERT INTO idempotency_records
         (organization_id, environment, idempotency_key, request_fingerprint, request_path, state)
       VALUES ($1, $2, $3, $4, $5, 'in_flight')
       ON CONFLICT (organization_id, environment, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        command.organizationId,
        command.environment,
        command.idempotencyKey,
        fingerprint,
        command.requestPath,
      ],
    );

    const claimedRecordId = claim.rows[0]?.id;
    if (claimedRecordId === undefined) {
      return this.decideForClaimHeldByAnother(client, command, fingerprint);
    }

    const publicId = generatePublicIdentifier('payment');
    const payment = await client.query<{ id: string }>(
      `INSERT INTO payments
         (public_id, organization_id, environment, merchant_reference, payment_method,
          currency, expected_amount_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        publicId,
        command.organizationId,
        command.environment,
        command.merchantReference,
        command.paymentMethod,
        command.currency,
        command.expectedAmountMinor.toString(),
      ],
    );

    const paymentId = payment.rows[0]?.id;
    if (paymentId === undefined) {
      throw new Error('inserting a payment returned no row');
    }

    const responseBody = { id: publicId, status: 'pending' };
    await client.query(
      `UPDATE idempotency_records
          SET state = 'completed', response_status = 201, response_body = $2,
              payment_id = $3, completed_at = now()
        WHERE id = $1`,
      [claimedRecordId, JSON.stringify(responseBody), paymentId],
    );

    return { kind: 'created', paymentId, publicId };
  }

  private async decideForClaimHeldByAnother(
    client: PoolClient,
    command: CreatePaymentCommand,
    fingerprint: Buffer,
  ): Promise<CreatePaymentResult> {
    const existing = await client.query<ExistingRecordRow>(
      `SELECT request_fingerprint, request_path, state, response_status, response_body
         FROM idempotency_records
        WHERE organization_id = $1 AND environment = $2 AND idempotency_key = $3`,
      [command.organizationId, command.environment, command.idempotencyKey],
    );

    const row = existing.rows[0];
    if (row === undefined) {
      // The holder rolled back between our insert and this read, so the key is
      // free again and the merchant may retry immediately.
      return { kind: 'in_flight' };
    }

    const decision: IdempotencyDecision = decideForExistingRecord(
      {
        requestFingerprint: row.request_fingerprint,
        requestPath: row.request_path,
        state: row.state,
        responseStatus: row.response_status,
        responseBody: row.response_body,
      },
      fingerprint,
      command.requestPath,
    );

    if (decision.kind === 'replay') {
      return {
        kind: 'replayed',
        responseStatus: decision.responseStatus,
        responseBody: decision.responseBody,
      };
    }
    if (decision.kind === 'conflict') {
      return { kind: 'conflict' };
    }
    return { kind: 'in_flight' };
  }

  public async createPayment(command: CreatePaymentCommand): Promise<CreatePaymentResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        command.organizationId,
      ]);

      const result = await this.createWithinTransaction(client, command);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolationOn(error, 'payments_one_live_per_merchant_reference')) {
        return { kind: 'duplicate_merchant_reference' };
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
