import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECONCILIATION_SCHEDULE,
  reconcileDuePayments,
} from './reconcile-payments.use-case.js';
import type { ReconciliationDependencies } from './reconcile-payments.use-case.js';
import type { DuePayment, ReconciliationStore } from './ports/payment-reconciliation.repository.js';
import type {
  ObservedLifecycle,
  ObservedPaymentState,
  PixPaymentProvider,
  ProviderResult,
} from './ports/payment-provider.js';
import { ProviderRegistry } from './provider-registry.js';
import type { ProviderDescriptor } from '../domain/provider/provider-capability.js';

/**
 * The rule under test throughout: a payment leaves `unknown` only on something
 * the provider actually said. Every other path must leave it uncertain.
 */

const DESCRIPTOR: ProviderDescriptor = {
  code: 'test-provider',
  displayName: 'Test Provider',
  capabilities: ['pix.create', 'pix.status'],
  supportedCurrencies: ['BRL'],
  instrumentCreationIsIdempotent: false,
};

const NOW = new Date('2026-09-09T12:00:00.000Z');

const DUE: DuePayment = {
  paymentId: 'internal-1',
  organizationId: 'organization-1',
  environment: 'SANDBOX',
  expectedAmountMinor: 10_000n,
  currency: 'BRL',
  attempts: 1,
  providerCode: 'test-provider',
  providerReference: '3531',
  attemptId: 'attempt-1',
};

interface RecordedCalls {
  readonly applied: {
    toStatus: string;
    trigger: string;
    evidenceClass: string;
    capturedAmountMinor: string | undefined;
  }[];
  readonly deferred: { note: string; dueAt: Date | undefined }[];
}

function storeFor(
  due: DuePayment[],
  applied: 'applied' | 'already_resolved' = 'applied',
): ReconciliationStore & { readonly calls: RecordedCalls } {
  const calls: RecordedCalls = { applied: [], deferred: [] };
  return {
    calls,
    claimDue: () => Promise.resolve(due),
    applyResolution: (command) => {
      calls.applied.push({
        toStatus: command.toStatus,
        trigger: command.trigger,
        evidenceClass: command.evidenceClass,
        capturedAmountMinor: command.capture?.amountMinor.toString(),
      });
      return Promise.resolve(applied);
    },
    deferResolution: (_paymentId, _organizationId, note, dueAt) => {
      calls.deferred.push({ note, dueAt });
      return Promise.resolve();
    },
  };
}

function observing(
  lifecycle: ObservedLifecycle,
  overrides: Partial<ObservedPaymentState> = {},
): PixPaymentProvider {
  const observed: ObservedPaymentState = {
    lifecycle,
    capturedAmountMinor: lifecycle === 'paid' ? 10_000n : 0n,
    paidAt: lifecycle === 'paid' ? new Date('2026-09-09T11:00:00.000Z') : undefined,
    rawStatus: lifecycle,
    ...overrides,
  };
  return provider(() =>
    Promise.resolve({ outcome: 'success', value: observed, providerReference: '3531' }),
  );
}

function provider(read: () => Promise<ProviderResult<ObservedPaymentState>>): PixPaymentProvider {
  return {
    descriptor: DESCRIPTOR,
    createPixInstrument: () =>
      Promise.reject(new Error('reconciliation must never create an instrument')),
    readPaymentState: read,
  };
}

function dependenciesFor(
  store: ReconciliationStore,
  pix: PixPaymentProvider,
  descriptor: ProviderDescriptor = DESCRIPTOR,
): ReconciliationDependencies {
  return {
    store,
    providers: new ProviderRegistry([{ descriptor, environment: 'SANDBOX', pix, priority: 1 }]),
    schedule: DEFAULT_RECONCILIATION_SCHEDULE,
    now: () => NOW,
  };
}

describe('an uncertain payment the provider can account for', () => {
  it('records it paid, with the provider read as the evidence', async () => {
    const store = storeFor([DUE]);
    const run = await reconcileDuePayments(dependenciesFor(store, observing('paid')));

    expect(run.resolutions[0]?.kind).toBe('resolved');
    expect(store.calls.applied[0]).toEqual({
      toStatus: 'paid',
      trigger: 'RECONCILED_PAID',
      // The transition table refuses this edge on anything less, and this is the
      // one place that could weaken it by claiming otherwise.
      evidenceClass: 'authenticated_provider_read',
      capturedAmountMinor: '10000',
    });
  });

  it('records a live instrument, so the customer can still pay', async () => {
    const store = storeFor([DUE]);
    await reconcileDuePayments(dependenciesFor(store, observing('awaiting_payment')));

    expect(store.calls.applied[0]?.toStatus).toBe('awaiting_payment');
    expect(store.calls.applied[0]?.trigger).toBe('RECONCILED_INSTRUMENT_LIVE');
    expect(store.calls.applied[0]?.capturedAmountMinor).toBeUndefined();
  });

  it('records a positive refusal as failed', async () => {
    const store = storeFor([DUE]);
    await reconcileDuePayments(dependenciesFor(store, observing('failed')));

    expect(store.calls.applied[0]?.toStatus).toBe('failed');
    expect(store.calls.applied[0]?.trigger).toBe('RECONCILED_FAILED');
  });

  it('records a lapsed instrument as expired', async () => {
    const store = storeFor([DUE]);
    await reconcileDuePayments(dependenciesFor(store, observing('expired')));

    expect(store.calls.applied[0]?.trigger).toBe('RECONCILED_EXPIRED');
  });
});

describe('an uncertain payment that stays uncertain', () => {
  it('leaves it unknown when the provider does not know either', async () => {
    const store = storeFor([DUE]);
    const run = await reconcileDuePayments(dependenciesFor(store, observing('unknown')));

    expect(run.resolutions[0]?.kind).toBe('still_unknown');
    expect(store.calls.applied).toHaveLength(0);
    expect(store.calls.deferred[0]?.dueAt).toBeInstanceOf(Date);
  });

  it('leaves it unknown when the inquiry itself fails', async () => {
    const store = storeFor([DUE]);
    const run = await reconcileDuePayments(
      dependenciesFor(
        store,
        provider(() =>
          Promise.resolve({ outcome: 'unknown_outcome', reason: 'the provider did not answer' }),
        ),
      ),
    );

    expect(run.resolutions[0]?.kind).toBe('cannot_inquire');
    expect(store.calls.applied).toHaveLength(0);
  });

  it('leaves it unknown when the adapter throws, and does not stop the batch', async () => {
    const store = storeFor([DUE, { ...DUE, paymentId: 'internal-2' }]);
    const run = await reconcileDuePayments(
      dependenciesFor(
        store,
        provider(() => Promise.reject(new Error('socket hang up'))),
      ),
    );

    expect(run.claimed).toBe(2);
    expect(run.resolutions).toHaveLength(2);
    expect(store.calls.applied).toHaveLength(0);
    expect(store.calls.deferred).toHaveLength(2);
  });

  it('cannot inquire when the attempt never recorded a provider reference', async () => {
    // Appmax has no order search, so this genuinely cannot be resolved by asking.
    const store = storeFor([{ ...DUE, providerReference: undefined }]);
    const run = await reconcileDuePayments(dependenciesFor(store, observing('paid')));

    expect(run.resolutions[0]?.kind).toBe('cannot_inquire');
    expect(store.calls.applied).toHaveLength(0);
  });

  it('cannot inquire when the provider does not declare pix.status', async () => {
    // Declared capability, not an attempted call that fails.
    const store = storeFor([DUE]);
    const withoutStatus: ProviderDescriptor = { ...DESCRIPTOR, capabilities: ['pix.create'] };
    const run = await reconcileDuePayments(
      dependenciesFor(store, observing('paid'), withoutStatus),
    );

    expect(run.resolutions[0]?.kind).toBe('cannot_inquire');
    expect(store.calls.deferred[0]?.note).toContain('pix.status');
  });

  it('cannot inquire about a provider configured for the other environment', async () => {
    const store = storeFor([{ ...DUE, environment: 'PRODUCTION' }]);
    const run = await reconcileDuePayments(dependenciesFor(store, observing('paid')));

    expect(run.resolutions[0]?.kind).toBe('cannot_inquire');
    expect(store.calls.applied).toHaveLength(0);
  });
});

describe('money is never invented', () => {
  it('refuses to record paid when the provider reports a different amount', async () => {
    // A Pix code carries a fixed amount, so the payer cannot have chosen another.
    // A disagreement means this reference is not the payment we think it is.
    const store = storeFor([DUE]);
    const run = await reconcileDuePayments(
      dependenciesFor(store, observing('paid', { capturedAmountMinor: 9900n })),
    );

    expect(store.calls.applied).toHaveLength(0);
    expect(run.resolutions[0]?.kind).toBe('still_unknown');
  });

  it('refuses to record paid with no time of payment', async () => {
    const store = storeFor([DUE]);
    await reconcileDuePayments(dependenciesFor(store, observing('paid', { paidAt: undefined })));

    expect(store.calls.applied).toHaveLength(0);
  });

  it('refuses to record paid when the provider reports nothing captured', async () => {
    const store = storeFor([DUE]);
    await reconcileDuePayments(
      dependenciesFor(store, observing('paid', { capturedAmountMinor: 0n })),
    );

    expect(store.calls.applied).toHaveLength(0);
  });

  it.each(['refunded', 'partially_refunded', 'chargeback'] as const)(
    'refuses to jump straight to %s from uncertain',
    async (lifecycle) => {
      // Each implies the payment was paid first. Inventing the intervening
      // capture to make the edge legal would fabricate the evidence.
      const store = storeFor([DUE]);
      const run = await reconcileDuePayments(dependenciesFor(store, observing(lifecycle)));

      expect(store.calls.applied).toHaveLength(0);
      expect(run.resolutions[0]?.kind).toBe('still_unknown');
    },
  );
});

describe('duplicate and concurrent reconciliation', () => {
  it('reports a payment another worker resolved first, without transitioning it again', async () => {
    const store = storeFor([DUE], 'already_resolved');
    const run = await reconcileDuePayments(dependenciesFor(store, observing('paid')));

    expect(run.resolutions[0]?.kind).toBe('already_resolved');
  });

  it('never asks a provider to create anything', async () => {
    // The stand-in rejects createPixInstrument, so reaching it fails the test.
    const store = storeFor([DUE]);
    await reconcileDuePayments(dependenciesFor(store, observing('paid')));

    expect(store.calls.applied).toHaveLength(1);
  });
});

describe('scheduling', () => {
  it('backs off further on each successive failure', async () => {
    const first = storeFor([{ ...DUE, attempts: 1 }]);
    const later = storeFor([{ ...DUE, attempts: 5 }]);

    await reconcileDuePayments(dependenciesFor(first, observing('unknown')));
    await reconcileDuePayments(dependenciesFor(later, observing('unknown')));

    const firstDelay = (first.calls.deferred[0]?.dueAt?.getTime() ?? 0) - NOW.getTime();
    const laterDelay = (later.calls.deferred[0]?.dueAt?.getTime() ?? 0) - NOW.getTime();
    expect(laterDelay).toBeGreaterThan(firstDelay);
  });

  it('caps the wait rather than growing it without bound', async () => {
    const store = storeFor([{ ...DUE, attempts: 11 }]);
    await reconcileDuePayments(dependenciesFor(store, observing('unknown')));

    const delaySeconds = ((store.calls.deferred[0]?.dueAt?.getTime() ?? 0) - NOW.getTime()) / 1000;
    expect(delaySeconds).toBeLessThanOrEqual(DEFAULT_RECONCILIATION_SCHEDULE.maximumBackoffSeconds);
  });

  it('stops scheduling once the inquiries are exhausted, leaving it to an operator', async () => {
    const store = storeFor([{ ...DUE, attempts: DEFAULT_RECONCILIATION_SCHEDULE.maximumAttempts }]);
    const run = await reconcileDuePayments(dependenciesFor(store, observing('unknown')));

    expect(run.resolutions[0]?.kind).toBe('awaiting_operator');
    // Unscheduled, not locked: the payment is still `unknown` and anything may
    // still move it.
    expect(store.calls.deferred[0]?.dueAt).toBeUndefined();
    expect(store.calls.deferred[0]?.note).toContain('Reconciliation stopped');
  });

  it('does nothing at all when nothing is due', async () => {
    const store = storeFor([]);
    const run = await reconcileDuePayments(dependenciesFor(store, observing('paid')));

    expect(run.claimed).toBe(0);
    expect(store.calls.applied).toHaveLength(0);
    expect(store.calls.deferred).toHaveLength(0);
  });
});
