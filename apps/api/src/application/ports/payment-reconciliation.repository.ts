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
  readonly expectedAmountMinor: bigint;
  readonly currency: string;
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
  }): Promise<'applied' | 'already_resolved'>;
  deferResolution(
    paymentId: string,
    organizationId: string,
    note: string,
    dueAt: Date | undefined,
  ): Promise<void>;
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
