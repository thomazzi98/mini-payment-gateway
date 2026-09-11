import type { PoolClient } from 'pg';

/**
 * The one way a payment changes status.
 *
 * Every mover goes through here because the database refuses a status change that
 * commits without a matching, legal, evidence-backed transition row carrying the
 * same sequence number. Two implementations of this would be two chances to write
 * the pair inconsistently, and the deferred trigger would then reject one of them
 * at commit for reasons the caller could not see.
 *
 * The caller supplies the transaction, so a move always commits with whatever
 * else made it true.
 */

export interface PaymentStatusMove {
  readonly paymentId: string;
  readonly organizationId: string;
  readonly toStatus: string;
  readonly trigger: string;
  readonly evidenceClass: string;
  readonly attemptId: string | null;
  readonly reason: string | null;
  /**
   * Present only when this move is the one that funds the payment.
   *
   * captured_amount_minor is the single source of truth for paid-ness: `status`
   * and `paid_at` are constrained to agree with it, so all three must move in the
   * same statement or the row is unwritable. The legacy system kept paid-ness in
   * two places and let five code paths disagree about it.
   */
  readonly capture?: {
    readonly amountMinor: bigint;
    readonly paidAt: Date;
  };
  /**
   * What a consumer of `payment.paid` needs, gathered by the caller because only
   * it knows which provider and attempt produced the money.
   */
  readonly eventContext?: {
    readonly publicId: string;
    readonly environment: string;
    readonly currency: string;
    readonly merchantReference: string;
    readonly paymentMethod: string;
    /**
     * Who to tell. Absent when the merchant gave no number, in which case the
     * event is still written and delivery records that nobody could be told.
     */
    readonly customerPhone: string | undefined;
    readonly providerCode: string | undefined;
    readonly providerReference: string | undefined;
  };
}

export async function movePaymentStatus(
  client: PoolClient,
  move: PaymentStatusMove,
): Promise<void> {
  // FOR UPDATE so two concurrent movers cannot read the same sequence number and
  // write two transitions claiming to be the same step.
  const current = await client.query<{
    status: string;
    status_sequence: string;
    captured_amount_minor: string;
  }>(
    'SELECT status, status_sequence, captured_amount_minor FROM payments WHERE id = $1 FOR UPDATE',
    [move.paymentId],
  );
  const currentRow = current.rows[0];
  if (currentRow === undefined) {
    throw new Error('the payment disappeared while a transition was being applied');
  }

  const nextSequence = Number(currentRow.status_sequence) + 1;
  const capturedAfter = move.capture?.amountMinor ?? BigInt(currentRow.captured_amount_minor);

  await client.query(
    `INSERT INTO payment_status_transitions
       (payment_id, organization_id, sequence_number, from_status, to_status,
        trigger_name, evidence_class, payment_attempt_id, captured_amount_after, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      move.paymentId,
      move.organizationId,
      nextSequence,
      currentRow.status,
      move.toStatus,
      move.trigger,
      move.evidenceClass,
      move.attemptId,
      capturedAfter.toString(),
      move.reason,
    ],
  );

  if (move.capture === undefined) {
    await client.query('UPDATE payments SET status = $2, status_sequence = $3 WHERE id = $1', [
      move.paymentId,
      move.toStatus,
      nextSequence,
    ]);
    return;
  }

  await client.query(
    `UPDATE payments
        SET status = $2, status_sequence = $3,
            captured_amount_minor = $4, paid_at = $5
      WHERE id = $1`,
    [
      move.paymentId,
      move.toStatus,
      nextSequence,
      move.capture.amountMinor.toString(),
      move.capture.paidAt,
    ],
  );

  await recordPaidEvent(client, move, move.capture);
}

/**
 * Writes `payment.paid` in the same transaction as the money.
 *
 * This is the whole guarantee: a payment cannot commit as paid while its event
 * fails to publish, because there is no moment at which one exists without the
 * other. Publishing after the commit would leave exactly that window, and the
 * payment nobody downstream ever hears about is the one that was paid.
 *
 * Written wherever a payment is funded rather than at each call site, so a future
 * path that captures money cannot forget to announce it.
 */
async function recordPaidEvent(
  client: PoolClient,
  move: PaymentStatusMove,
  capture: { readonly amountMinor: bigint; readonly paidAt: Date },
): Promise<void> {
  const context = move.eventContext;
  if (context === undefined) {
    throw new Error(
      'a payment cannot be funded without the context its paid event carries; the caller must supply eventContext',
    );
  }

  const payload = {
    paymentId: context.publicId,
    organizationId: move.organizationId,
    merchantReference: context.merchantReference,
    environment: context.environment,
    paymentMethod: context.paymentMethod,
    currency: context.currency,
    amountMinor: capture.amountMinor.toString(),
    paidAt: capture.paidAt.toISOString(),
    customerPhone: context.customerPhone ?? null,
    provider: context.providerCode ?? null,
    providerReference: context.providerReference ?? null,
    paymentAttemptId: move.attemptId,
  };

  // ON CONFLICT DO NOTHING against the one-paid-per-payment constraint. A payment
  // reaching paid twice is already refused by the transition table; this makes the
  // event side of it a no-op rather than an error, so a retry that got further
  // than it thought cannot fail on the announcement.
  await client.query(
    `INSERT INTO payment_events (payment_id, organization_id, event_type, payload, occurred_at)
     VALUES ($1, $2, 'payment.paid', $3, $4)
     ON CONFLICT (payment_id, event_type) DO NOTHING`,
    [move.paymentId, move.organizationId, JSON.stringify(payload), capture.paidAt],
  );
}
