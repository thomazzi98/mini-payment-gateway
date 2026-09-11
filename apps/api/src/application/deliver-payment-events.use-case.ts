import { createMoney, formatMoney, isSupportedCurrency } from '@gateway/shared';
import type {
  DeliverablePaymentEvent,
  PaymentEventStore,
} from './ports/payment-event.repository.js';
import type { PaymentPaidNotifier } from './ports/payment-notifier.js';

/**
 * Handing the paid event to the notification service.
 *
 * The rule this keeps: nothing here touches a payment. An event that cannot be
 * delivered stays an event that cannot be delivered; the payment it describes
 * is paid, and was paid before this ran. Delivery is bookkeeping about the
 * announcement, never about the money.
 *
 * The notification service is called between transactions, never inside one,
 * for the same reason a provider is.
 */

export interface DeliverySchedule {
  readonly batchSize: number;
  readonly leaseSeconds: number;
  readonly maximumAttempts: number;
  readonly baseBackoffSeconds: number;
  readonly maximumBackoffSeconds: number;
}

export const DEFAULT_DELIVERY_SCHEDULE: DeliverySchedule = {
  batchSize: 20,
  leaseSeconds: 60,
  maximumAttempts: 10,
  baseBackoffSeconds: 15,
  maximumBackoffSeconds: 900,
};

export interface DeliveryDependencies {
  readonly store: PaymentEventStore;
  readonly notifier: PaymentPaidNotifier;
  readonly schedule: DeliverySchedule;
  readonly now: () => Date;
  readonly onEventError?: (eventId: string, error: unknown) => void;
}

type DeliveryOutcome =
  | { readonly kind: 'delivered'; readonly reference: string }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'deferred'; readonly reason: string }
  | { readonly kind: 'abandoned'; readonly reason: string }
  | { readonly kind: 'unreadable'; readonly reason: string };

interface EventDelivery {
  readonly eventId: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly attempts: number;
  readonly outcome: DeliveryOutcome;
}

export interface DeliveryRun {
  readonly claimed: number;
  readonly deliveries: readonly EventDelivery[];
  readonly failed: number;
}

/**
 * The fields the message is built from. Everything else in the payload is
 * carried for consumers and ignored here.
 */
interface PaidPayload {
  readonly paymentId: string;
  readonly merchantReference: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly paidAt: string;
  readonly customerPhone: string | undefined;
}

function readPaidPayload(payload: unknown): PaidPayload | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.paymentId !== 'string' ||
    typeof candidate.merchantReference !== 'string' ||
    typeof candidate.currency !== 'string' ||
    typeof candidate.amountMinor !== 'string' ||
    !/^\d+$/.test(candidate.amountMinor) ||
    typeof candidate.paidAt !== 'string'
  ) {
    return undefined;
  }
  return {
    paymentId: candidate.paymentId,
    merchantReference: candidate.merchantReference,
    currency: candidate.currency,
    amountMinor: BigInt(candidate.amountMinor),
    paidAt: candidate.paidAt,
    customerPhone:
      typeof candidate.customerPhone === 'string' ? candidate.customerPhone : undefined,
  };
}

function describeAmount(payload: PaidPayload): string {
  if (isSupportedCurrency(payload.currency)) {
    return formatMoney(createMoney(payload.amountMinor, payload.currency));
  }
  return `${payload.currency} ${payload.amountMinor.toString()} (minor units)`;
}

export function composeMessage(payload: PaidPayload): string {
  return `Payment ${payload.merchantReference} confirmed: ${describeAmount(payload)} received at ${payload.paidAt}. Gateway payment ${payload.paymentId}.`;
}

function backoffSeconds(attempts: number, schedule: DeliverySchedule): number {
  const doubled = schedule.baseBackoffSeconds * 2 ** Math.max(attempts - 1, 0);
  return Math.min(doubled, schedule.maximumBackoffSeconds);
}

export async function deliverDuePaymentEvents(
  dependencies: DeliveryDependencies,
): Promise<DeliveryRun> {
  const due = await dependencies.store.claimDue(
    dependencies.schedule.batchSize,
    dependencies.schedule.leaseSeconds,
  );

  const deliveries: EventDelivery[] = [];
  let failed = 0;
  for (const event of due) {
    try {
      deliveries.push(await deliverOne(event, dependencies));
    } catch (error) {
      // One event the store refuses must not stop the batch. It stays leased and
      // becomes due again on its own, so nothing is lost by skipping it here.
      failed += 1;
      dependencies.onEventError?.(event.eventId, error);
    }
  }

  return { claimed: due.length, deliveries, failed };
}

async function deliverOne(
  event: DeliverablePaymentEvent,
  dependencies: DeliveryDependencies,
): Promise<EventDelivery> {
  const subject = {
    eventId: event.eventId,
    organizationId: event.organizationId,
    eventType: event.eventType,
    attempts: event.attempts,
  };
  const outcome = await decide(event, dependencies);
  return { ...subject, outcome };
}

async function decide(
  event: DeliverablePaymentEvent,
  dependencies: DeliveryDependencies,
): Promise<DeliveryOutcome> {
  const payload = readPaidPayload(event.payload);
  if (payload === undefined) {
    // Not something retrying will fix, and not something to guess at either: a
    // payload nobody can read must not become a message with the wrong amount.
    const reason = 'The event payload is not a paid event this worker can read.';
    await dependencies.store.abandon({
      eventId: event.eventId,
      organizationId: event.organizationId,
      failure: reason,
    });
    return { kind: 'unreadable', reason };
  }

  if (payload.customerPhone === undefined) {
    const reason = 'The payment carries no customer phone, so there is nobody to notify.';
    await dependencies.store.markSkipped({
      eventId: event.eventId,
      organizationId: event.organizationId,
      reason,
    });
    return { kind: 'skipped', reason };
  }

  const result = await attemptNotification(event, payload, dependencies.notifier);

  if (result.kind === 'accepted') {
    await dependencies.store.markDelivered({
      eventId: event.eventId,
      organizationId: event.organizationId,
      reference: result.reference,
    });
    return { kind: 'delivered', reference: result.reference };
  }

  if (result.kind === 'refused' || event.attempts >= dependencies.schedule.maximumAttempts) {
    const reason =
      result.kind === 'refused'
        ? result.reason
        : `Delivery stopped after ${event.attempts} attempts: ${result.reason}`;
    await dependencies.store.abandon({
      eventId: event.eventId,
      organizationId: event.organizationId,
      failure: reason,
    });
    return { kind: 'abandoned', reason };
  }

  const wait = backoffSeconds(event.attempts, dependencies.schedule);
  await dependencies.store.defer({
    eventId: event.eventId,
    organizationId: event.organizationId,
    dueAt: new Date(dependencies.now().getTime() + wait * 1000),
    failure: result.reason,
  });
  return { kind: 'deferred', reason: result.reason };
}

/**
 * A notifier that throws is read as "ask again later", never as accepted and
 * never as refused: nothing about an exception says which.
 */
async function attemptNotification(
  event: DeliverablePaymentEvent,
  payload: PaidPayload,
  notifier: PaymentPaidNotifier,
) {
  try {
    return await notifier.notify({
      eventId: event.eventId,
      recipient: payload.customerPhone ?? '',
      message: composeMessage(payload),
      metadata: {
        eventType: event.eventType,
        paymentId: payload.paymentId,
        merchantReference: payload.merchantReference,
      },
    });
  } catch (error) {
    return {
      kind: 'retry' as const,
      reason:
        error instanceof Error
          ? `The notification call ended in an error: ${error.message}`
          : 'The notification call ended in an error.',
    };
  }
}
