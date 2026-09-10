import type { Pool } from 'pg';
import { completeIdempotencyRecord } from './complete-idempotency-record.js';
import { movePaymentStatus } from './payment-status-move.js';
import type {
  DuePayment,
  ReconciliationStore,
  StrandedPayment,
  StrandedPaymentStore,
} from '../../application/ports/payment-reconciliation.repository.js';

/**
 * Finding and resolving payments whose outcome was never determined.
 *
 * Work is claimed by lease rather than by holding a row lock: the claim moves the
 * due time forward and commits immediately, so nothing is held while the provider
 * is called. A transaction open across a network round trip would keep row locks
 * for the length of somebody else's outage, and a worker that died holding one
 * would strand the payment until the connection was reaped.
 *
 * A lease is not a lock. If the worker dies, the lease simply elapses and the
 * payment becomes due again, so no payment can be permanently withheld from
 * reconciliation by a process that is no longer running.
 */

interface DueRow {
  readonly id: string;
  readonly organization_id: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly expected_amount_minor: string;
  readonly currency: string;
  readonly reconciliation_attempts: number;
  readonly provider_code: string | null;
  readonly provider_reference: string | null;
  readonly attempt_id: string | null;
}

export class PaymentReconciliationRepository implements ReconciliationStore, StrandedPaymentStore {
  public constructor(private readonly pool: Pool) {}

  /**
   * Claims up to `limit` payments that are due, and leases them.
   *
   * Discovery runs through a SECURITY DEFINER function because a worker resolves
   * payments for every organization and has no tenant to scope itself to until it
   * has read one. Every write it then performs is tenant-scoped in the ordinary
   * way, so the relaxation covers this step alone.
   */
  public async claimDue(limit: number, leaseSeconds: number): Promise<DuePayment[]> {
    const claimed = await this.pool.query<DueRow>(
      'SELECT * FROM claim_payments_for_reconciliation($1, $2)',
      [limit, leaseSeconds],
    );

    return claimed.rows.map((row) => ({
      paymentId: row.id,
      organizationId: row.organization_id,
      environment: row.environment,
      expectedAmountMinor: BigInt(row.expected_amount_minor),
      currency: row.currency,
      attempts: row.reconciliation_attempts,
      providerCode: row.provider_code ?? undefined,
      providerReference: row.provider_reference ?? undefined,
      attemptId: row.attempt_id ?? undefined,
    }));
  }

  /**
   * Applies a resolution. The status change, its transition and any capture all
   * commit together, because the schema refuses them apart.
   *
   * Idempotent against a payment that another worker resolved first: the move is
   * only attempted while the payment is still `unknown`, and a payment that has
   * moved on is reported as already resolved rather than transitioned twice.
   */
  public async applyResolution(
    command: Parameters<ReconciliationStore['applyResolution']>[0],
  ): Promise<'applied' | 'already_resolved'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        command.organizationId,
      ]);

      const current = await client.query<{ status: string }>(
        'SELECT status FROM payments WHERE id = $1 FOR UPDATE',
        [command.paymentId],
      );
      if (current.rows[0]?.status !== 'unknown') {
        await client.query('COMMIT');
        return 'already_resolved';
      }

      await movePaymentStatus(client, {
        paymentId: command.paymentId,
        organizationId: command.organizationId,
        toStatus: command.toStatus,
        trigger: command.trigger,
        evidenceClass: command.evidenceClass,
        attemptId: command.attemptId,
        reason: command.reason,
        ...(command.capture !== undefined && { capture: command.capture }),
      });

      await client.query('UPDATE payments SET reconciliation_note = $2 WHERE id = $1', [
        command.paymentId,
        command.reason,
      ]);

      await client.query('COMMIT');
      return 'applied';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Leaves the payment uncertain and schedules the next inquiry.
   *
   * `dueAt` of undefined stops scheduling entirely. The payment stays `unknown`,
   * which is the truth, and becomes an operator's to resolve. It is not locked:
   * anything may still move it, and rescheduling is one UPDATE.
   */
  public async deferResolution(
    paymentId: string,
    organizationId: string,
    note: string,
    dueAt: Date | undefined,
  ): Promise<void> {
    // Tenant-scoped like every other write. Without the scope, row level security
    // matches nothing and the update silently does nothing at all, which looks
    // exactly like a payment that was rescheduled.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        organizationId,
      ]);
      await client.query(
        `UPDATE payments
            SET reconciliation_due_at = $2, reconciliation_note = $3
          WHERE id = $1 AND status = 'unknown'`,
        [paymentId, dueAt ?? null, note],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Payments abandoned mid-flight, in `processing` or `pending` with nothing
   * working on them any more.
   */
  public async findStranded(olderThanSeconds: number, limit: number): Promise<StrandedPayment[]> {
    const found = await this.pool.query<{
      id: string;
      organization_id: string;
      public_id: string;
      environment: 'SANDBOX' | 'PRODUCTION';
      status: string;
      currency: string;
      expected_amount_minor: string;
      merchant_reference: string;
      idempotency_key: string | null;
    }>('SELECT * FROM find_stranded_payments($1, $2)', [olderThanSeconds, limit]);

    return found.rows.map((row) => ({
      paymentId: row.id,
      organizationId: row.organization_id,
      publicId: row.public_id,
      environment: row.environment,
      status: row.status,
      currency: row.currency,
      expectedAmountMinor: BigInt(row.expected_amount_minor),
      merchantReference: row.merchant_reference,
      idempotencyKey: row.idempotency_key ?? undefined,
    }));
  }

  /**
   * Moves an abandoned payment to `unknown` and releases its claim together.
   *
   * The claim is completed with what the payment now is rather than with what the
   * caller received, because the caller received nothing: the process handling
   * their request died. A retry of that key then learns the payment exists and is
   * uncertain, which is both true and actionable, instead of being told forever
   * that something is still being processed.
   */
  public async markUncertain(payment: StrandedPayment, reason: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        payment.organizationId,
      ]);

      const current = await client.query<{ status: string }>(
        'SELECT status FROM payments WHERE id = $1 FOR UPDATE',
        [payment.paymentId],
      );
      const status = current.rows[0]?.status;
      if (status !== 'processing' && status !== 'pending') {
        // It moved on by itself while we were looking. Nothing to recover.
        await client.query('COMMIT');
        return false;
      }

      await movePaymentStatus(client, {
        paymentId: payment.paymentId,
        organizationId: payment.organizationId,
        toStatus: 'unknown',
        trigger: 'PROVIDER_OUTCOME_UNKNOWN',
        // Internal, and correctly so: nobody read a provider. What is being
        // recorded is our own ignorance, which is exactly what `unknown` is for.
        evidenceClass: 'internal',
        attemptId: null,
        reason,
      });

      await client.query('UPDATE payments SET reconciliation_note = $2 WHERE id = $1', [
        payment.paymentId,
        reason,
      ]);

      if (payment.idempotencyKey !== undefined) {
        await completeIdempotencyRecord(client, {
          organizationId: payment.organizationId,
          environment: payment.environment,
          idempotencyKey: payment.idempotencyKey,
          responseStatus: 202,
          responseBody: {
            id: payment.publicId,
            status: 'unknown',
            amountMinor: payment.expectedAmountMinor.toString(),
            currency: payment.currency,
            merchantReference: payment.merchantReference,
            failureCode: 'provider_outcome_unknown',
            failureReason: reason,
          },
        });
      }

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Payments reconciliation has stopped scheduling. The operator backlog.
   */
  public async countAwaitingOperator(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      'SELECT count_payments_awaiting_operator() AS count',
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}
