/**
 * What reconciliation needs from storage, in the gateway's own vocabulary.
 *
 * Claiming is by lease rather than by lock, which is the part that matters here:
 * the adapter must let a worker take work, release its transaction, call a
 * provider, and come back. A port that handed out held locks would force the
 * provider call to happen inside a transaction.
 */

export interface DuePayment {
  readonly paymentId: string;
  readonly organizationId: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  /**
   * The status this payment was claimed from, and the reason the two are never
   * merged: `unknown` is uncertainty about whether an operation happened at all,
   * while `awaiting_payment` is certainty that it did and that nobody has paid
   * yet. They resolve through different triggers, and a failure to inquire means
   * something different in each.
   */
  readonly status: 'unknown' | 'awaiting_payment';
  readonly expectedAmountMinor: bigint;
  readonly currency: string;
  /**
   * When the instrument itself lapses, as the provider reported it at creation.
   * Absent when the provider named none.
   */
  readonly expiresAt: Date | undefined;
  readonly attempts: number;
  readonly providerCode: string | undefined;
  readonly providerReference: string | undefined;
  readonly attemptId: string | undefined;
}

export interface ReconciliationStore {
  claimDue(limit: number, leaseSeconds: number): Promise<DuePayment[]>;
  applyResolution(command: {
    readonly paymentId: string;
    readonly organizationId: string;
    readonly attemptId: string | null;
    readonly toStatus: string;
    readonly trigger: string;
    readonly evidenceClass: string;
    readonly reason: string;
    readonly capture?: { readonly amountMinor: bigint; readonly paidAt: Date };
    /**
     * Which provider interaction produced this, for the paid event to carry.
     */
    readonly providerCode: string | undefined;
    readonly providerReference: string | undefined;
  }): Promise<'applied' | 'already_resolved'>;
  deferResolution(command: {
    readonly paymentId: string;
    readonly organizationId: string;
    readonly note: string;
    readonly dueAt: Date | undefined;
    /**
     * True when the provider answered and its answer was simply "not yet".
     *
     * That is a healthy payment behaving normally, not a failure, so it must not
     * consume the budget that exists to stop asking about payments nobody can
     * answer for. Without this an unpaid Pix would be abandoned to an operator
     * after a dozen perfectly good replies.
     */
    readonly isHealthy: boolean;
  }): Promise<void>;
}

/**
 * A payment abandoned mid-flight: a request was sent and no answer was recorded.
 */
export interface StrandedPayment {
  readonly paymentId: string;
  readonly organizationId: string;
  readonly publicId: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly status: string;
  readonly currency: string;
  readonly expectedAmountMinor: bigint;
  readonly merchantReference: string;
  /**
   * The claim still held open on this payment's behalf, if any. Releasing it is
   * the point of the sweep: left in flight it answers every retry of that key
   * with "still being processed" and then "stranded", forever.
   */
  readonly idempotencyKey: string | undefined;
}

export interface StrandedPaymentStore {
  findStranded(olderThanSeconds: number, limit: number): Promise<StrandedPayment[]>;
  /**
   * Closes an abandoned payment and completes its claim, in one transaction.
   *
   * Where it goes depends on where it was abandoned, and the two are genuinely
   * different: see the adapter. Returns false when the payment moved on by itself
   * in the meantime.
   */
  recoverAbandoned(payment: StrandedPayment, reason: string): Promise<boolean>;
}
