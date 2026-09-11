import { describe, expect, it } from 'vitest';
import {
  composeMessage,
  DEFAULT_DELIVERY_SCHEDULE,
  deliverDuePaymentEvents,
} from './deliver-payment-events.use-case.js';
import type { DeliveryDependencies } from './deliver-payment-events.use-case.js';
import type {
  DeliverablePaymentEvent,
  PaymentEventStore,
} from './ports/payment-event.repository.js';
import type {
  NotificationOutcome,
  PaidNotification,
  PaymentPaidNotifier,
} from './ports/payment-notifier.js';

const NOW = new Date('2026-09-11T00:00:00.000Z');

const PAYLOAD = {
  paymentId: 'payment_01hzx',
  organizationId: 'organization-1',
  merchantReference: 'order-1',
  environment: 'SANDBOX',
  paymentMethod: 'crypto',
  currency: 'USDC',
  amountMinor: '25000000',
  paidAt: '2026-09-11T00:10:00.000Z',
  customerPhone: '+5515999998888',
  provider: 'cryptopay',
  providerReference: 'pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
  paymentAttemptId: 'attempt-1',
};

function eventWith(
  overrides: Partial<DeliverablePaymentEvent> & { readonly payload?: unknown } = {},
): DeliverablePaymentEvent {
  return {
    eventId: 'event-1',
    organizationId: 'organization-1',
    eventType: 'payment.paid',
    payload: PAYLOAD,
    occurredAt: NOW,
    attempts: 1,
    ...overrides,
  };
}

interface Calls {
  delivered: { eventId: string; reference: string }[];
  skipped: { eventId: string; reason: string }[];
  deferred: { eventId: string; dueAt: Date; failure: string }[];
  abandoned: { eventId: string; failure: string }[];
}

function storeWith(due: DeliverablePaymentEvent[]): PaymentEventStore & { calls: Calls } {
  const calls: Calls = { delivered: [], skipped: [], deferred: [], abandoned: [] };
  return {
    calls,
    claimDue: () => Promise.resolve(due),
    markDelivered: (command) => {
      calls.delivered.push({ eventId: command.eventId, reference: command.reference });
      return Promise.resolve();
    },
    markSkipped: (command) => {
      calls.skipped.push({ eventId: command.eventId, reason: command.reason });
      return Promise.resolve();
    },
    defer: (command) => {
      calls.deferred.push({
        eventId: command.eventId,
        dueAt: command.dueAt,
        failure: command.failure,
      });
      return Promise.resolve();
    },
    abandon: (command) => {
      calls.abandoned.push({ eventId: command.eventId, failure: command.failure });
      return Promise.resolve();
    },
  };
}

function notifierAnswering(
  outcome: NotificationOutcome | Error,
): PaymentPaidNotifier & { sent: PaidNotification[] } {
  const sent: PaidNotification[] = [];
  return {
    sent,
    notify: (notification) => {
      sent.push(notification);
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
}

function dependencies(
  store: PaymentEventStore,
  notifier: PaymentPaidNotifier,
  overrides: Partial<DeliveryDependencies> = {},
): DeliveryDependencies {
  return {
    store,
    notifier,
    schedule: DEFAULT_DELIVERY_SCHEDULE,
    now: () => NOW,
    ...overrides,
  };
}

describe('delivering paid events', () => {
  it('hands the event to the notifier with the event id as the idempotency key', async () => {
    const store = storeWith([eventWith()]);
    const notifier = notifierAnswering({ kind: 'accepted', reference: 'notification-1' });

    const run = await deliverDuePaymentEvents(dependencies(store, notifier));

    expect(run.claimed).toBe(1);
    expect(run.deliveries[0]?.outcome).toEqual({ kind: 'delivered', reference: 'notification-1' });
    expect(notifier.sent[0]).toEqual({
      eventId: 'event-1',
      recipient: '+5515999998888',
      message: composeMessage({
        paymentId: 'payment_01hzx',
        merchantReference: 'order-1',
        currency: 'USDC',
        amountMinor: 25_000_000n,
        paidAt: '2026-09-11T00:10:00.000Z',
        customerPhone: '+5515999998888',
      }),
      metadata: {
        eventType: 'payment.paid',
        paymentId: 'payment_01hzx',
        merchantReference: 'order-1',
      },
    });
    expect(store.calls.delivered).toEqual([{ eventId: 'event-1', reference: 'notification-1' }]);
  });

  it('writes the amount in the asset, never as a float', () => {
    const message = composeMessage({
      paymentId: 'payment_1',
      merchantReference: 'order-1',
      currency: 'USDC',
      amountMinor: 25_000_000n,
      paidAt: '2026-09-11T00:10:00.000Z',
      customerPhone: '+5515999998888',
    });
    expect(message).toContain('USDC 25.000000');
    expect(message).toContain('order-1');
    expect(message).toContain('payment_1');
  });

  it('skips an event whose payment carries no recipient, and calls nobody', async () => {
    const store = storeWith([eventWith({ payload: { ...PAYLOAD, customerPhone: null } })]);
    const notifier = notifierAnswering({ kind: 'accepted', reference: 'never' });

    const run = await deliverDuePaymentEvents(dependencies(store, notifier));

    expect(run.deliveries[0]?.outcome.kind).toBe('skipped');
    expect(notifier.sent).toHaveLength(0);
    expect(store.calls.skipped).toHaveLength(1);
    expect(store.calls.delivered).toHaveLength(0);
  });

  it('defers with backoff when the platform asks to be tried later', async () => {
    const store = storeWith([eventWith({ attempts: 3 })]);
    const notifier = notifierAnswering({ kind: 'retry', reason: 'answered 503' });

    const run = await deliverDuePaymentEvents(dependencies(store, notifier));

    expect(run.deliveries[0]?.outcome).toEqual({ kind: 'deferred', reason: 'answered 503' });
    // 15s doubled twice for the third attempt.
    expect(store.calls.deferred[0]?.dueAt).toEqual(new Date(NOW.getTime() + 60_000));
    expect(store.calls.deferred[0]?.failure).toBe('answered 503');
    expect(store.calls.abandoned).toHaveLength(0);
  });

  it('reads a notifier that throws as retry later, never as accepted', async () => {
    const store = storeWith([eventWith()]);
    const notifier = notifierAnswering(new Error('socket hang up'));

    const run = await deliverDuePaymentEvents(dependencies(store, notifier));

    expect(run.deliveries[0]?.outcome.kind).toBe('deferred');
    expect(store.calls.delivered).toHaveLength(0);
  });

  it('abandons an event the platform refuses outright', async () => {
    const store = storeWith([eventWith()]);
    const notifier = notifierAnswering({ kind: 'refused', reason: 'recipient invalid' });

    const run = await deliverDuePaymentEvents(dependencies(store, notifier));

    expect(run.deliveries[0]?.outcome).toEqual({ kind: 'abandoned', reason: 'recipient invalid' });
    expect(store.calls.abandoned).toEqual([{ eventId: 'event-1', failure: 'recipient invalid' }]);
  });

  it('abandons after the attempt budget is spent on retryable failures', async () => {
    const store = storeWith([eventWith({ attempts: DEFAULT_DELIVERY_SCHEDULE.maximumAttempts })]);
    const notifier = notifierAnswering({ kind: 'retry', reason: 'still down' });

    const run = await deliverDuePaymentEvents(dependencies(store, notifier));

    expect(run.deliveries[0]?.outcome.kind).toBe('abandoned');
    expect(store.calls.abandoned[0]?.failure).toContain('still down');
    expect(store.calls.deferred).toHaveLength(0);
  });

  it('abandons a payload it cannot read instead of guessing a message', async () => {
    const store = storeWith([eventWith({ payload: { paymentId: 'x', amountMinor: 12.5 } })]);
    const notifier = notifierAnswering({ kind: 'accepted', reference: 'never' });

    const run = await deliverDuePaymentEvents(dependencies(store, notifier));

    expect(run.deliveries[0]?.outcome.kind).toBe('unreadable');
    expect(notifier.sent).toHaveLength(0);
    expect(store.calls.abandoned).toHaveLength(1);
  });

  it('isolates an event the store refuses so the batch continues', async () => {
    const failing = storeWith([
      eventWith({ eventId: 'event-1' }),
      eventWith({ eventId: 'event-2' }),
    ]);
    const original = failing.markDelivered.bind(failing);
    failing.markDelivered = (command) =>
      command.eventId === 'event-1'
        ? Promise.reject(new Error('refused by the database'))
        : original(command);
    const errors: string[] = [];

    const run = await deliverDuePaymentEvents(
      dependencies(failing, notifierAnswering({ kind: 'accepted', reference: 'n' }), {
        onEventError: (eventId) => {
          errors.push(eventId);
        },
      }),
    );

    expect(run.failed).toBe(1);
    expect(errors).toEqual(['event-1']);
    expect(run.deliveries.map((delivery) => delivery.eventId)).toEqual(['event-2']);
  });
});
