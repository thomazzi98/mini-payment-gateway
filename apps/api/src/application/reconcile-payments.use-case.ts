import type { ObservedPaymentState } from './ports/payment-provider.js';
import type { DuePayment, ReconciliationStore } from './ports/payment-reconciliation.repository.js';
import type { ProviderRegistry } from './provider-registry.js';

/**
 * Resolving payments whose outcome was never determined.
 *
 * The single rule this exists to keep: a payment moves out of `unknown` only on
 * something the provider actually said. Every path that cannot produce that
 * leaves the payment uncertain, which is unhelpful but true, and true is the only
 * thing that can be safely built on afterwards.
 *
 * The provider is called between transactions, never inside one, for the same
 * reason payment creation does it that way.
 */

export interface ReconciliationSchedule {
  /**
   * How long a claimed payment is left alone before it becomes due again. It
   * bounds how long a worker that dies mid-inquiry delays that payment, and
   * nothing else.
   */
  readonly leaseSeconds: number;
  readonly batchSize: number;
  /**
   * After this many inquiries that resolved nothing, scheduling stops and the
   * payment becomes an operator's. It stays `unknown` and unlocked; it is simply
   * no longer asked about, because something is wrong that retrying will not fix.
   */
  readonly maximumAttempts: number;
  readonly baseBackoffSeconds: number;
  readonly maximumBackoffSeconds: number;
}

export const DEFAULT_RECONCILIATION_SCHEDULE: ReconciliationSchedule = {
  leaseSeconds: 120,
  batchSize: 20,
  maximumAttempts: 12,
  baseBackoffSeconds: 30,
  maximumBackoffSeconds: 3600,
};

export interface ReconciliationDependencies {
  readonly store: ReconciliationStore;
  readonly providers: ProviderRegistry;
  readonly schedule: ReconciliationSchedule;
  readonly now: () => Date;
}

/**
 * Enough to find the payment again without going back to the database, and
 * nothing a log must not carry. A provider reference is the provider's own
 * identifier for the order, not a credential.
 */
export interface ResolutionSubject {
  readonly paymentId: string;
  readonly organizationId: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly providerCode: string | undefined;
  readonly providerReference: string | undefined;
  readonly attemptId: string | undefined;
  readonly attempts: number;
}

/**
 * What reconciliation concluded, separate from which payment it concluded it
 * about, so the two can be composed without Omit distributing over the union.
 */
export type ResolutionOutcome =
  | { readonly kind: 'resolved'; readonly toStatus: string; readonly trigger: string }
  | { readonly kind: 'already_resolved' }
  /**
  The provider answered, and its answer was that it does not know either.
  */
  | { readonly kind: 'still_unknown'; readonly reason: string }
  /**
  Nothing can be asked: no reference, no provider, or no status capability.
  */
  | { readonly kind: 'cannot_inquire'; readonly reason: string }
  /**
  Scheduling has stopped. The payment is an operator's now.
  */
  | { readonly kind: 'awaiting_operator'; readonly reason: string };

export type PaymentResolution = ResolutionSubject & ResolutionOutcome;

export interface ReconciliationRun {
  readonly claimed: number;
  readonly resolutions: readonly PaymentResolution[];
}

/**
 * Doubling, capped. A provider that is down stays down for a while, and asking it
 * every thirty seconds for an hour is how a recovering provider is kept down.
 */
function backoffSeconds(attempts: number, schedule: ReconciliationSchedule): number {
  const doubled = schedule.baseBackoffSeconds * 2 ** Math.max(attempts - 1, 0);
  return Math.min(doubled, schedule.maximumBackoffSeconds);
}

/**
 * What an observed provider state licenses, expressed as a transition out of
 * `unknown`.
 *
 * `refunded`, `partially_refunded` and `chargeback` are deliberately absent. They
 * are real answers, but none is reachable from `unknown` in one step: each implies
 * the payment was paid first, and inventing the intervening capture to make the
 * edge legal would fabricate the very evidence this exists to demand. They become
 * an operator's problem, correctly.
 */
function transitionForObservation(observed: ObservedPaymentState):
  | {
      readonly toStatus: string;
      readonly trigger: string;
      readonly requiresCapture: boolean;
    }
  | undefined {
  if (observed.lifecycle === 'paid') {
    return { toStatus: 'paid', trigger: 'RECONCILED_PAID', requiresCapture: true };
  }
  if (observed.lifecycle === 'awaiting_payment') {
    return {
      toStatus: 'awaiting_payment',
      trigger: 'RECONCILED_INSTRUMENT_LIVE',
      requiresCapture: false,
    };
  }
  if (observed.lifecycle === 'expired') {
    return { toStatus: 'expired', trigger: 'RECONCILED_EXPIRED', requiresCapture: false };
  }
  if (observed.lifecycle === 'failed') {
    return { toStatus: 'failed', trigger: 'RECONCILED_FAILED', requiresCapture: false };
  }
  return undefined;
}

export async function reconcileDuePayments(
  dependencies: ReconciliationDependencies,
): Promise<ReconciliationRun> {
  const due = await dependencies.store.claimDue(
    dependencies.schedule.batchSize,
    dependencies.schedule.leaseSeconds,
  );

  const resolutions: PaymentResolution[] = [];
  for (const payment of due) {
    resolutions.push(await reconcileOne(payment, dependencies));
  }

  return { claimed: due.length, resolutions };
}

function subjectOf(payment: DuePayment): ResolutionSubject {
  return {
    paymentId: payment.paymentId,
    organizationId: payment.organizationId,
    environment: payment.environment,
    providerCode: payment.providerCode,
    providerReference: payment.providerReference,
    attemptId: payment.attemptId,
    attempts: payment.attempts,
  };
}

async function reconcileOne(
  payment: DuePayment,
  dependencies: ReconciliationDependencies,
): Promise<PaymentResolution> {
  const subject = subjectOf(payment);
  const inquiry = await inquire(payment, dependencies);

  if (inquiry.kind === 'observed') {
    const applied = await applyObservation(payment, inquiry.observed, dependencies);
    if (applied !== undefined) {
      return { ...subject, ...applied };
    }
  }

  const reason = inquiry.kind === 'observed' ? describeUnusable(inquiry.observed) : inquiry.reason;

  // Nothing usable came back. Either ask again later, or stop asking.
  if (payment.attempts >= dependencies.schedule.maximumAttempts) {
    await dependencies.store.deferResolution(
      payment.paymentId,
      payment.organizationId,
      `Reconciliation stopped after ${payment.attempts} inquiries: ${reason}`,
      undefined,
    );
    return { ...subject, kind: 'awaiting_operator', reason };
  }

  const wait = backoffSeconds(payment.attempts, dependencies.schedule);
  await dependencies.store.deferResolution(
    payment.paymentId,
    payment.organizationId,
    reason,
    new Date(dependencies.now().getTime() + wait * 1000),
  );

  return inquiry.kind === 'observed'
    ? { ...subject, kind: 'still_unknown', reason }
    : { ...subject, kind: 'cannot_inquire', reason };
}

type InquiryResult =
  | { readonly kind: 'observed'; readonly observed: ObservedPaymentState }
  | { readonly kind: 'unavailable'; readonly reason: string };

async function inquire(
  payment: DuePayment,
  dependencies: ReconciliationDependencies,
): Promise<InquiryResult> {
  if (payment.providerCode === undefined || payment.providerReference === undefined) {
    // The attempt never got far enough to be told a reference, so there is
    // nothing to ask about. Appmax offers no order search, so this genuinely
    // cannot be resolved by inquiry and only a person can close it.
    return {
      kind: 'unavailable',
      reason: 'The uncertain attempt carries no provider reference, so nothing can be inquired.',
    };
  }

  const selection = dependencies.providers.selectForPixStatus(
    payment.providerCode,
    payment.environment,
  );
  if (!selection.selected) {
    return { kind: 'unavailable', reason: selection.reason };
  }

  try {
    const result = await selection.provider.readPaymentState(payment.providerReference);
    if (result.outcome === 'success') {
      return { kind: 'observed', observed: result.value };
    }
    return { kind: 'unavailable', reason: result.reason };
  } catch (error) {
    // An adapter that throws must not stop the batch, and must never be read as
    // an answer about the payment.
    return {
      kind: 'unavailable',
      reason:
        error instanceof Error
          ? `The provider inquiry ended in an error: ${error.message}`
          : 'The provider inquiry ended in an error.',
    };
  }
}

/**
 * Returns undefined when the observation cannot be acted on, which leaves the
 * payment uncertain rather than moving it somewhere convenient.
 */
async function applyObservation(
  payment: DuePayment,
  observed: ObservedPaymentState,
  dependencies: ReconciliationDependencies,
): Promise<ResolutionOutcome | undefined> {
  const transition = transitionForObservation(observed);
  if (transition === undefined) {
    return undefined;
  }

  let capture: { amountMinor: bigint; paidAt: Date } | undefined;
  if (transition.requiresCapture) {
    // A Pix code carries a fixed amount, so the payer cannot choose a different
    // one. An amount that disagrees is not a partial payment; it is a sign that
    // this reference is not the payment we think it is, and recording it would
    // put a number nobody verified into the ledger.
    if (
      observed.capturedAmountMinor !== payment.expectedAmountMinor ||
      observed.paidAt === undefined
    ) {
      return undefined;
    }
    capture = { amountMinor: observed.capturedAmountMinor, paidAt: observed.paidAt };
  }

  const outcome = await dependencies.store.applyResolution({
    paymentId: payment.paymentId,
    organizationId: payment.organizationId,
    attemptId: payment.attemptId ?? null,
    toStatus: transition.toStatus,
    trigger: transition.trigger,
    // Only ever this. The transition table refuses these edges on anything less,
    // and this is the one place that could weaken it by claiming otherwise.
    evidenceClass: 'authenticated_provider_read',
    reason: `Provider reported ${observed.rawStatus}.`,
    ...(capture !== undefined && { capture }),
  });

  if (outcome === 'already_resolved') {
    return { kind: 'already_resolved' };
  }
  return { kind: 'resolved', toStatus: transition.toStatus, trigger: transition.trigger };
}

function describeUnusable(observed: ObservedPaymentState): string {
  if (observed.lifecycle === 'unknown') {
    return `The provider could not determine the outcome (reported ${observed.rawStatus}).`;
  }
  return `The provider reported ${observed.rawStatus}, which cannot be applied to an uncertain payment without an operator.`;
}
