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
