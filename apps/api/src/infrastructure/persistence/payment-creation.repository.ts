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

export interface RecordAttemptCommand {
  readonly organizationId: string;
  readonly paymentId: string;
  readonly attemptNumber: number;
  readonly providerCode: string;
}

export interface ApplyOutcomeCommand {
  readonly organizationId: string;
  readonly paymentId: string;
  readonly attemptId: string;
  readonly outcomeClass: string;
  readonly providerReference: string | undefined;
  readonly failureReason: string | undefined;
  /**
  The status the payment moves to, and the trigger that justifies it.
  */
  readonly toStatus: string;
  readonly trigger: string;
  readonly evidenceClass: string;
  readonly idempotencyKey: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  /**
  What the caller is about to be told, stored so a replay says the same thing.
  */
  readonly responseStatus: number;
  readonly responseBody: unknown;
}

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

    // The record stays in flight: the response is not known until the provider has
    // answered, and completing it here would let a replay return a payment that
    // has no instrument yet.
    await client.query('UPDATE idempotency_records SET payment_id = $2 WHERE id = $1', [
      claimedRecordId,
      paymentId,
    ]);

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

  /**
   * Opens an attempt before the provider is called.
   *
   * Written first, and committed, so that a crash during the network call leaves
   * evidence that something was tried. An attempt that exists with no outcome is
   * exactly the signal reconciliation needs; one that was never written would
   * leave a payment that had unknowingly been sent to a provider.
   */
  public async openAttempt(command: RecordAttemptCommand): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        command.organizationId,
      ]);

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO payment_attempts
           (public_id, payment_id, organization_id, attempt_number, provider_code)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          generatePublicIdentifier('paymentAttempt'),
          command.paymentId,
          command.organizationId,
          command.attemptNumber,
          command.providerCode,
        ],
      );

      await client.query('COMMIT');
      const attemptId = inserted.rows[0]?.id;
      if (attemptId === undefined) {
        throw new Error('opening a payment attempt returned no row');
      }
      return attemptId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Closes the attempt, moves the payment, and completes the idempotency record,
   * all in one transaction.
   *
   * The status change and its audit row commit together because the database
   * refuses them apart, and the idempotency response is written here rather than
   * at creation so a replay returns what the caller actually received.
   */
  public async applyProviderOutcome(command: ApplyOutcomeCommand): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        command.organizationId,
      ]);

      await client.query(
        `UPDATE payment_attempts
            SET outcome_class = $2, provider_reference = $3, failure_reason = $4,
                finished_at = now()
          WHERE id = $1`,
        [
          command.attemptId,
          command.outcomeClass,
          command.providerReference ?? null,
          command.failureReason ?? null,
        ],
      );

      const current = await client.query<{ status: string; status_sequence: string }>(
        'SELECT status, status_sequence FROM payments WHERE id = $1 FOR UPDATE',
        [command.paymentId],
      );
      const fromStatus = current.rows[0]?.status;
      if (fromStatus === undefined) {
        throw new Error('the payment disappeared while its attempt was in flight');
      }
      const nextSequence = Number(current.rows[0]?.status_sequence ?? 0) + 1;

      await client.query(
        `INSERT INTO payment_status_transitions
           (payment_id, organization_id, sequence_number, from_status, to_status,
            trigger_name, evidence_class, payment_attempt_id, captured_amount_after, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)`,
        [
          command.paymentId,
          command.organizationId,
          nextSequence,
          fromStatus,
          command.toStatus,
          command.trigger,
          command.evidenceClass,
          command.attemptId,
          command.failureReason ?? null,
        ],
      );

      await client.query('UPDATE payments SET status = $2, status_sequence = $3 WHERE id = $1', [
        command.paymentId,
        command.toStatus,
        nextSequence,
      ]);

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

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
