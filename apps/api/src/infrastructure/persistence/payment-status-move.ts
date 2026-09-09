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
}
