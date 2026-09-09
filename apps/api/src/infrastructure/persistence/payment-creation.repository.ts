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

export interface FailRoutingCommand {
  readonly organizationId: string;
  readonly paymentId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly responseStatus: number;
  readonly responseBody: unknown;
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
   * Moves a payment and writes the transition that justifies the move.
   *
   * Both happen here because the database refuses them apart: a deferred
   * constraint trigger rejects any status change that commits without a matching,
   * legal, evidence-backed transition row carrying the same sequence number.
   *
   * The caller supplies the transaction, so a move always commits with whatever
   * else made it true.
   */
  private async moveStatus(
    client: PoolClient,
    move: {
      readonly paymentId: string;
      readonly organizationId: string;
      readonly toStatus: string;
      readonly trigger: string;
      readonly evidenceClass: string;
      readonly attemptId: string | null;
      readonly reason: string | null;
    },
  ): Promise<void> {
    // FOR UPDATE so two concurrent movers cannot read the same sequence number
    // and write two transitions claiming to be the same step.
    const current = await client.query<{ status: string; status_sequence: string }>(
      'SELECT status, status_sequence FROM payments WHERE id = $1 FOR UPDATE',
      [move.paymentId],
    );
    const currentRow = current.rows[0];
    if (currentRow === undefined) {
      throw new Error('the payment disappeared while an attempt was in flight');
    }
    const nextSequence = Number(currentRow.status_sequence) + 1;

    await client.query(
      `INSERT INTO payment_status_transitions
         (payment_id, organization_id, sequence_number, from_status, to_status,
          trigger_name, evidence_class, payment_attempt_id, captured_amount_after, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)`,
      [
        move.paymentId,
        move.organizationId,
        nextSequence,
        currentRow.status,
        move.toStatus,
        move.trigger,
        move.evidenceClass,
        move.attemptId,
        move.reason,
      ],
    );

    await client.query('UPDATE payments SET status = $2, status_sequence = $3 WHERE id = $1', [
      move.paymentId,
      move.toStatus,
      nextSequence,
    ]);
  }

  private async completeIdempotencyRecord(
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

  /**
   * Fails a payment that never reached a provider, and releases its claim.
   *
   * ROUTING_EXHAUSTED is a declared edge out of pending precisely for this: the
   * schema anticipated a payment nothing could serve. No attempt exists, so the
   * transition carries no attempt id.
   *
   * Completing the idempotency record here is the part that matters. Left in
   * flight, the key would answer "still being processed" to every retry forever,
   * and the payment would go on holding the merchant reference.
   */
  public async failRouting(command: FailRoutingCommand): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        command.organizationId,
      ]);

      await this.moveStatus(client, {
        paymentId: command.paymentId,
        organizationId: command.organizationId,
        toStatus: 'failed',
        trigger: 'ROUTING_EXHAUSTED',
        evidenceClass: 'internal',
        attemptId: null,
        reason: command.reason,
      });

      await this.completeIdempotencyRecord(client, command);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Opens an attempt before the provider is called, and records that a request is
   * being sent.
   *
   * Both are committed before the network call. A crash mid-flight therefore
   * leaves a payment in `processing` carrying an attempt with no outcome, which is
   * exactly the signal reconciliation needs. Had nothing been written, a payment
   * that had unknowingly reached a provider would look untouched.
   *
   * The move to `processing` is also what makes the outcome legal: the transition
   * table permits `awaiting_payment`, `failed` and `unknown` only from
   * `processing`, so an attempt that skipped this step could not be closed.
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
      const attemptId = inserted.rows[0]?.id;
      if (attemptId === undefined) {
        throw new Error('opening a payment attempt returned no row');
      }

      await this.moveStatus(client, {
        paymentId: command.paymentId,
        organizationId: command.organizationId,
        toStatus: 'processing',
        trigger: 'PROVIDER_REQUEST_SENT',
        evidenceClass: 'internal',
        attemptId,
        reason: null,
      });

      await client.query('COMMIT');
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

      // The provider reference is recorded on the attempt, never on the payment.
      // A payment may be attempted against several providers, so a single column
      // on the payment could only ever hold one of them and would silently become
      // whichever was written last.
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

      await this.moveStatus(client, {
        paymentId: command.paymentId,
        organizationId: command.organizationId,
        toStatus: command.toStatus,
        trigger: command.trigger,
        evidenceClass: command.evidenceClass,
        attemptId: command.attemptId,
        reason: command.failureReason ?? null,
      });

      await this.completeIdempotencyRecord(client, command);

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
