import type { ObservedPaymentState } from './ports/payment-provider.js';
import type {
  DuePayment,
  ReconciliationStore,
  StrandedPaymentStore,
} from './ports/payment-reconciliation.repository.js';
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
  /**
   * How often to ask about a payment that is live and unpaid. Steady rather than
   * backing off, because the answer is expected to change and asking costs one
   * call.
   */
  readonly waitingPollSeconds: number;
  /**
   * How long a payment may sit in `processing` or `pending` before it is treated
   * as abandoned. Generous, because a payment that is merely slow must never be
   * swept out from under the request still working on it.
   */
  readonly strandedAfterSeconds: number;
  /**
   * How long after an instrument's own expiry a payment may still be waiting
   * before it is recorded as expired.
   *
   * A margin rather than the bare timestamp, because the provider's clock and
   * ours are not the same clock, and recording a payment expired one second early
   * would deny a customer who paid inside the window.
   */
  readonly expiryGraceSeconds: number;
}

export const DEFAULT_RECONCILIATION_SCHEDULE: ReconciliationSchedule = {
  leaseSeconds: 120,
  batchSize: 20,
  maximumAttempts: 12,
  baseBackoffSeconds: 30,
  maximumBackoffSeconds: 3600,
  waitingPollSeconds: 60,
  strandedAfterSeconds: 900,
  expiryGraceSeconds: 300,
};

export interface ReconciliationDependencies {
  readonly store: ReconciliationStore;
  readonly stranded: StrandedPaymentStore;
  readonly providers: ProviderRegistry;
  readonly schedule: ReconciliationSchedule;
  readonly now: () => Date;
  /**
   * Reports a payment this batch could not act on. Optional because the decision
   * to continue belongs here; how loudly to say so belongs to the caller.
   */
  readonly onPaymentError?: (paymentId: string, error: unknown) => void;
}

/**
 * Enough to find the payment again without going back to the database, and
 * nothing a log must not carry. A provider reference is the provider's own
 * identifier for the order, not a credential.
 */
interface ResolutionSubject {
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
type ResolutionOutcome =
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
  The provider answered, and the answer was that nobody has paid yet. The expected
  reply for most of an instrument's life, and not a failure.
  */
  | { readonly kind: 'still_awaiting'; readonly reason: string }
  /**
  Scheduling has stopped. The payment is an operator's now.
  */
  | { readonly kind: 'awaiting_operator'; readonly reason: string };

export type PaymentResolution = ResolutionSubject & ResolutionOutcome;

export interface ReconciliationRun {
  readonly claimed: number;
  readonly resolutions: readonly PaymentResolution[];
  /**
   * Payments abandoned mid-flight that were closed so the ordinary machinery can
   * take them.
   */
  readonly recovered: number;
  /**
   * Payments this batch could not act on because acting on them raised. Counted
   * rather than thrown: one payment the database refuses must not stop the batch,
   * or a single unworkable row halts reconciliation for every other merchant.
   */
  readonly failed: number;
}

/**
 * Closes payments abandoned mid-flight, and releases their claims.
 *
 * Neither is discoverable by anything else, and both hold their merchant
 * reference and their idempotency key for as long as they sit there. Where each
 * goes is the adapter's decision, because it depends on what the status already
 * proves about whether anything was created.
 */
async function recoverStrandedPayments(
  dependencies: ReconciliationDependencies,
): Promise<{ recovered: number; failed: number }> {
  const stranded = await dependencies.stranded.findStranded(
    dependencies.schedule.strandedAfterSeconds,
    dependencies.schedule.batchSize,
  );

  let recovered = 0;
  let failed = 0;
  for (const payment of stranded) {
    try {
      const isMoved = await dependencies.stranded.recoverAbandoned(
        payment,
        `Abandoned in ${payment.status} with no outcome recorded.`,
      );
      if (isMoved) {
        recovered += 1;
      }
    } catch (error) {
      // Isolated deliberately. A payment the database will not move — a row whose
      // history is inconsistent, say — would otherwise fail every batch forever
      // and stop reconciliation for everyone else.
      failed += 1;
      dependencies.onPaymentError?.(payment.paymentId, error);
    }
  }
  return { recovered, failed };
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
function transitionForObservation(
  observed: ObservedPaymentState,
  from: 'unknown' | 'awaiting_payment',
):
  | {
      readonly toStatus: string;
      readonly trigger: string;
      readonly requiresCapture: boolean;
    }
  | undefined {
  // A payment we know exists and know is unpaid resolves through ordinary
  // lifecycle vocabulary. A payment whose creation may never have taken effect
  // resolves through discovery vocabulary. An operator reading the history should
  // be able to tell which question was being answered.
  if (from === 'awaiting_payment') {
    if (observed.lifecycle === 'paid') {
      return { toStatus: 'paid', trigger: 'PAYMENT_CONFIRMED', requiresCapture: true };
    }
    if (observed.lifecycle === 'expired') {
      return { toStatus: 'expired', trigger: 'EXPIRY_ELAPSED', requiresCapture: false };
    }
    if (observed.lifecycle === 'failed') {
      return { toStatus: 'failed', trigger: 'PAYMENT_REFUSED', requiresCapture: false };
    }
    // Still waiting. Not a transition, and not a failure either: this is the
    // expected answer for most of a Pix code's life.
    return undefined;
  }

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
  // First, because a payment abandoned mid-flight is not yet uncertain as far as
  // the queue is concerned, and moving it makes it so.
  const recovered = await recoverStrandedPayments(dependencies);

  const due = await dependencies.store.claimDue(
    dependencies.schedule.batchSize,
    dependencies.schedule.leaseSeconds,
  );

  const resolutions: PaymentResolution[] = [];
  let failed = recovered.failed;
  for (const payment of due) {
    try {
      resolutions.push(await reconcileOne(payment, dependencies));
    } catch (error) {
      // Same isolation, same reason. The payment stays leased and becomes due
      // again on its own, so nothing is lost by skipping it here.
      failed += 1;
      dependencies.onPaymentError?.(payment.paymentId, error);
    }
  }

  return { claimed: due.length, resolutions, recovered: recovered.recovered, failed };
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

  // A payment that is simply not paid yet stays exactly where it is. This is the
  // distinction the design rests on: an inquiry that failed says nothing about the
  // payment, and an inquiry that succeeded and reported "not yet" says the payment
  // is healthy. Neither makes it uncertain, and turning either into `unknown`
  // would manufacture doubt about an operation that demonstrably happened.
  if (payment.status === 'awaiting_payment') {
    return { ...subject, ...(await deferWaiting(payment, inquiry, dependencies)) };
  }

  const reason = inquiry.kind === 'observed' ? describeUnusable(inquiry.observed) : inquiry.reason;

  // Nothing usable came back. Either ask again later, or stop asking.
  if (payment.attempts >= dependencies.schedule.maximumAttempts) {
    await dependencies.store.deferResolution({
      paymentId: payment.paymentId,
      organizationId: payment.organizationId,
      note: `Reconciliation stopped after ${payment.attempts} inquiries: ${reason}`,
      dueAt: undefined,
      isHealthy: false,
    });
    return { ...subject, kind: 'awaiting_operator', reason };
  }

  const wait = backoffSeconds(payment.attempts, dependencies.schedule);
  await dependencies.store.deferResolution({
    paymentId: payment.paymentId,
    organizationId: payment.organizationId,
    note: reason,
    dueAt: new Date(dependencies.now().getTime() + wait * 1000),
    isHealthy: false,
  });

  return inquiry.kind === 'observed'
    ? { ...subject, kind: 'still_unknown', reason }
    : { ...subject, kind: 'cannot_inquire', reason };
}

/**
 * Reschedules a payment that is still waiting to be paid.
 *
 * An inquiry that succeeded and said "not yet" costs nothing from the attempt
 * budget, because the budget exists to stop asking about payments nobody can
 * answer for, and this is a payment somebody answered for. An inquiry that failed
 * does spend it, and exhausting it leaves the payment waiting and unscheduled for
 * an operator — never uncertain.
 */
async function deferWaiting(
  payment: DuePayment,
  inquiry: InquiryResult,
  dependencies: ReconciliationDependencies,
): Promise<ResolutionOutcome> {
  const isHealthy = inquiry.kind === 'observed';
  const reason = isHealthy
    ? 'The provider reports the instrument is live and unpaid.'
    : inquiry.reason;

  if (!isHealthy && payment.attempts >= dependencies.schedule.maximumAttempts) {
    await dependencies.store.deferResolution({
      paymentId: payment.paymentId,
      organizationId: payment.organizationId,
      note: `Could not reach the provider in ${payment.attempts} inquiries: ${reason}`,
      dueAt: undefined,
      isHealthy: false,
    });
    return { kind: 'awaiting_operator', reason };
  }

  const wait = isHealthy
    ? dependencies.schedule.waitingPollSeconds
    : backoffSeconds(payment.attempts, dependencies.schedule);

  await dependencies.store.deferResolution({
    paymentId: payment.paymentId,
    organizationId: payment.organizationId,
    note: reason,
    dueAt: new Date(dependencies.now().getTime() + wait * 1000),
    isHealthy,
  });

  return { kind: 'still_awaiting', reason };
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

  const selection = dependencies.providers.selectForStatus(
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
  const transition =
    expiredTransitionFor(payment, observed, dependencies) ??
    transitionForObservation(observed, payment.status);
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
    providerCode: payment.providerCode,
    providerReference: payment.providerReference,
    ...(capture !== undefined && { capture }),
  });

  if (outcome === 'already_resolved') {
    return { kind: 'already_resolved' };
  }
  return { kind: 'resolved', toStatus: transition.toStatus, trigger: transition.trigger };
}

/**
 * Records an unpaid instrument that has outlived itself.
 *
 * Requires both halves: the instrument's own expiry, passed by a margin, AND a
 * provider read that came back and confirmed nobody has paid. A timestamp alone is
 * a guess, and guesses are not recorded here as facts. With the read it is not a
 * guess — the provider was asked and said no money arrived.
 *
 * Only from `awaiting_payment`. A payment in `unknown` has no instrument anybody
 * has confirmed, so it has nothing to have outlived.
 */
function expiredTransitionFor(
  payment: DuePayment,
  observed: ObservedPaymentState,
  dependencies: ReconciliationDependencies,
):
  | { readonly toStatus: string; readonly trigger: string; readonly requiresCapture: boolean }
  | undefined {
  if (payment.status !== 'awaiting_payment' || payment.expiresAt === undefined) {
    return undefined;
  }
  if (observed.lifecycle !== 'awaiting_payment') {
    return undefined;
  }

  const deadline = payment.expiresAt.getTime() + dependencies.schedule.expiryGraceSeconds * 1000;
  if (dependencies.now().getTime() <= deadline) {
    return undefined;
  }
  return { toStatus: 'expired', trigger: 'EXPIRY_ELAPSED', requiresCapture: false };
}

function describeUnusable(observed: ObservedPaymentState): string {
  if (observed.lifecycle === 'unknown') {
    return `The provider could not determine the outcome (reported ${observed.rawStatus}).`;
  }
  return `The provider reported ${observed.rawStatus}, which cannot be applied to an uncertain payment without an operator.`;
}
