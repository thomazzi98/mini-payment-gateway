import type { Pool, PoolClient } from 'pg';
import { generatePublicIdentifier } from '@gateway/shared';
import { completeIdempotencyRecord } from './complete-idempotency-record.js';
import { movePaymentStatus } from './payment-status-move.js';
import {
  decideForExistingRecord,
  fingerprintRequest,
} from '../../domain/idempotency/idempotency.js';
import type { IdempotencyDecision } from '../../domain/idempotency/idempotency.js';
import type { PaymentMethod } from '../../domain/provider/provider-capability.js';
import type { PresentedInstrument } from '../../application/create-payment.use-case.js';

export interface CreatePaymentCommand {
  readonly organizationId: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly merchantReference: string;
  readonly paymentMethod: PaymentMethod;
  readonly currency: string;
  readonly expectedAmountMinor: bigint;
  readonly customerPhone: string | undefined;
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
  | { readonly kind: 'duplicate_merchant_reference' }
  | { readonly kind: 'stranded' }
  | { readonly kind: 'amount_exceeds_limit'; readonly maximumAmountMinor: bigint };

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
   * False while the payment is still being routed to another provider. The claim
   * stays open until an outcome is actually returned, so a replay never sees a
   * response that a later attempt superseded.
   */
  readonly completesRequest: boolean;
  /**
  What the caller is about to be told, stored so a replay says the same thing.
  */
  readonly responseStatus: number;
  readonly responseBody: unknown;
  /**
   * When the instrument the provider issued lapses. Stored so reconciliation can
   * tell an unpaid payment that is still live from one that has outlived itself;
   * without it, nothing knows a Pix code has died.
   */
  readonly instrumentExpiresAt: Date | undefined;
  /**
   * What the customer was shown, kept on the attempt that issued it. A later read
   * of the payment presents this rather than asking the provider again.
   */
  readonly instrument: PresentedInstrument | undefined;
}

interface ExistingRecordRow {
  readonly request_fingerprint: Buffer;
  readonly request_path: string;
  readonly state: 'in_flight' | 'completed';
  readonly response_status: number | null;
  readonly response_body: unknown;
  readonly expires_at: Date;
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
 * The claim and the payment happen in one transaction, so there is no window in
 * which a key is claimed but its payment is missing, and a crash rolls both back
 * so the merchant may simply retry.
 *
 * The claim is NOT completed here. The response is not known until a provider has
 * answered, and completing it early would let a replay return a status and body
 * the caller never received. Completion happens in applyProviderOutcome or
 * failRouting, whichever settles the payment.
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

    // Checked before the key is claimed, not after. Refusing afterwards left the
    // claim committed against a request that never became a payment, so the key
    // was consumed and every retry of it was answered "still being processed"
    // and then "stranded", forever.
    //
    // Still inside the transaction, so a ceiling changed concurrently cannot be
    // read before the change and applied after it. The trigger on payments
    // enforces the same rule; this exists so a merchant over the limit is told
    // so rather than meeting a database exception.
    const ceiling = await client.query<{ maximum_payment_amount_minor: string }>(
      'SELECT maximum_payment_amount_minor FROM organizations WHERE id = $1',
      [command.organizationId],
    );
    const ceilingRow = ceiling.rows[0];
    if (ceilingRow === undefined) {
      throw new Error('the organization creating a payment does not exist');
    }
    const maximumAmountMinor = BigInt(ceilingRow.maximum_payment_amount_minor);
    if (command.expectedAmountMinor > maximumAmountMinor) {
      return { kind: 'amount_exceeds_limit', maximumAmountMinor };
    }

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
          currency, expected_amount_minor, customer_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        publicId,
        command.organizationId,
        command.environment,
        command.merchantReference,
        command.paymentMethod,
        command.currency,
        command.expectedAmountMinor.toString(),
        command.customerPhone ?? null,
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
      `SELECT request_fingerprint, request_path, state, response_status, response_body,
              expires_at
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
        expiresAt: row.expires_at,
      },
      fingerprint,
      command.requestPath,
      new Date(),
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
    if (decision.kind === 'stranded') {
      return { kind: 'stranded' };
    }
    return { kind: 'in_flight' };
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

      await movePaymentStatus(client, {
        paymentId: command.paymentId,
        organizationId: command.organizationId,
        toStatus: 'failed',
        trigger: 'ROUTING_EXHAUSTED',
        evidenceClass: 'internal',
        attemptId: null,
        reason: command.reason,
      });

      await completeIdempotencyRecord(client, command);

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

      await movePaymentStatus(client, {
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
                instrument = $5, finished_at = now()
          WHERE id = $1`,
        [
          command.attemptId,
          command.outcomeClass,
          command.providerReference ?? null,
          command.failureReason ?? null,
          command.instrument === undefined ? null : JSON.stringify(command.instrument),
        ],
      );

      if (command.instrumentExpiresAt !== undefined) {
        await client.query('UPDATE payments SET expires_at = $2 WHERE id = $1', [
          command.paymentId,
          command.instrumentExpiresAt,
        ]);
      }

      await movePaymentStatus(client, {
        paymentId: command.paymentId,
        organizationId: command.organizationId,
        toStatus: command.toStatus,
        trigger: command.trigger,
        evidenceClass: command.evidenceClass,
        attemptId: command.attemptId,
        reason: command.failureReason ?? null,
      });

      if (command.completesRequest) {
        await completeIdempotencyRecord(client, command);
      }

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
