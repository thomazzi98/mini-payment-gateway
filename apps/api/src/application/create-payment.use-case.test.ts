import { describe, expect, it } from 'vitest';
import { payableBrCode } from '../domain/pix/br-code.test-support.js';
import { createPayment } from './create-payment.use-case.js';
import type {
  CreatePaymentInput,
  CreatePaymentOutcome,
  PaymentCreationStore,
  PresentedInstrument,
} from './create-payment.use-case.js';
import { ProviderRegistry } from './provider-registry.js';
import type {
  PixInstrument,
  PixPaymentProvider,
  ProviderResult,
} from './ports/payment-provider.js';
import type { ProviderDescriptor } from '../domain/provider/provider-capability.js';

/**
 * A stand-in provider, described only in domain vocabulary. Naming a real adapter
 * here would make the application layer depend on infrastructure, which is the
 * coupling the lint boundary exists to prevent.
 */
const TEST_DESCRIPTOR: ProviderDescriptor = {
  code: 'test-provider',
  displayName: 'Test Provider',
  capabilities: ['pix.create', 'pix.status'],
  supportedCurrencies: ['BRL'],
  instrumentCreationIsIdempotent: false,
};

interface RecordedCalls {
  readonly opened: { paymentId: string; providerCode: string; attemptNumber: number }[];
  readonly routingFailures: { paymentId: string; reason: string; responseStatus: number }[];
  readonly applied: {
    outcomeClass: string;
    toStatus: string;
    trigger: string;
    providerReference: string | undefined;
    responseStatus: number;
    completesRequest: boolean;
    evidenceClass: string;
  }[];
}

function storeThatCreates(): PaymentCreationStore & { readonly calls: RecordedCalls } {
  const calls: RecordedCalls = { opened: [], applied: [], routingFailures: [] };
  return {
    calls,
    createPayment: () =>
      Promise.resolve({
        kind: 'created' as const,
        paymentId: 'internal-1',
        publicId: 'pay_0123456789abcdefghjkmnpqrs',
      }),
    openAttempt: (command) => {
      calls.opened.push({
        paymentId: command.paymentId,
        providerCode: command.providerCode,
        attemptNumber: command.attemptNumber,
      });
      return Promise.resolve(`attempt-${calls.opened.length}`);
    },
    failRouting: (command) => {
      calls.routingFailures.push({
        paymentId: command.paymentId,
        reason: command.reason,
        responseStatus: command.responseStatus,
      });
      return Promise.resolve();
    },
    applyProviderOutcome: (command) => {
      calls.applied.push({
        outcomeClass: command.outcomeClass,
        toStatus: command.toStatus,
        trigger: command.trigger,
        providerReference: command.providerReference,
        responseStatus: command.responseStatus,
        completesRequest: command.completesRequest,
        evidenceClass: command.evidenceClass,
      });
      return Promise.resolve();
    },
  };
}

function providerReturning(result: ProviderResult<PixInstrument>): PixPaymentProvider {
  return {
    descriptor: TEST_DESCRIPTOR,
    createPixInstrument: () => Promise.resolve(result),
    readPaymentState: () =>
      Promise.resolve({ outcome: 'unknown_outcome' as const, reason: 'not used here' }),
  };
}

function registryOfferingCode(code: string): ProviderRegistry {
  return registryWith(providerReturning(instrumentFrom(GOOD_INSTRUMENT, code)));
}

function paymentOf(outcome: Awaited<ReturnType<typeof createPayment>>) {
  if (!('payment' in outcome)) {
    throw new Error(`expected an outcome carrying a payment, got ${outcome.kind}`);
  }
  return outcome.payment;
}

function pixInstrumentOf(
  outcome: CreatePaymentOutcome,
): PresentedInstrument & { readonly type: 'pix' } {
  const instrument = paymentOf(outcome).instrument;
  if (instrument?.type !== 'pix') {
    throw new Error('expected a pix instrument');
  }
  return instrument;
}

function reasonOf(outcome: Awaited<ReturnType<typeof createPayment>>): string {
  if (!('reason' in outcome)) {
    throw new Error(`expected an outcome carrying a reason, got ${outcome.kind}`);
  }
  return outcome.reason;
}

function instrumentFrom(
  result: ProviderResult<PixInstrument>,
  code: string,
): ProviderResult<PixInstrument> {
  if (result.outcome !== 'success') {
    throw new Error('expected a successful instrument');
  }
  return { ...result, value: { ...result.value, copyAndPasteCode: code } };
}

function registryWith(provider: PixPaymentProvider): ProviderRegistry {
  return new ProviderRegistry([
    { descriptor: provider.descriptor, environment: 'SANDBOX', pix: provider, priority: 1 },
  ]);
}

const INPUT: CreatePaymentInput = {
  organizationId: 'organization-1',
  environment: 'SANDBOX',
  merchantReference: 'order-1',
  paymentMethod: 'pix',
  currency: 'BRL',
  expectedAmountMinor: 1000n,
  description: 'A digital thing',
  customer: {
    firstName: 'Junior',
    lastName: 'Almeida',
    email: 'junior@example.com',
    phone: '51983655100',
    documentNumber: '25226493029',
    ipAddress: '127.0.0.1',
  },
  idempotencyKey: 'key-1',
  requestPath: '/v1/payments',
  requestBody: { amount: 1000 },
};

const GOOD_INSTRUMENT: ProviderResult<PixInstrument> = {
  outcome: 'success',
  providerReference: '3531',
  value: {
    copyAndPasteCode: payableBrCode('10.00'),
    qrCodeImageDataUri: 'data:image/png;base64,AAAA',
    expiresAt: new Date('2026-09-09T18:30:00.000Z'),
  },
};

describe('a payment that succeeds', () => {
  it('opens one attempt, issues the instrument and returns it', async () => {
    const store = storeThatCreates();
    const outcome = await createPayment(INPUT, {
      store,
      providers: registryWith(providerReturning(GOOD_INSTRUMENT)),
    });

    expect(outcome.kind).toBe('created');
    expect(pixInstrumentOf(outcome).copyAndPasteCode).toBe(payableBrCode('10.00'));
    expect(paymentOf(outcome).status).toBe('awaiting_payment');
    // Money leaves as a string, so a large amount cannot silently lose precision
    // passing through a JSON number.
    expect(paymentOf(outcome).amountMinor).toBe('1000');

    expect(store.calls.opened).toEqual([
      { paymentId: 'internal-1', providerCode: 'test-provider', attemptNumber: 1 },
    ]);
    expect(store.calls.applied[0]).toEqual({
      outcomeClass: 'success',
      toStatus: 'awaiting_payment',
      trigger: 'INSTRUMENT_ISSUED',
      providerReference: '3531',
      responseStatus: 201,
      completesRequest: true,
      evidenceClass: 'authenticated_provider_read',
    });
  });
});

describe('a payment the provider definitively refuses', () => {
  it('fails the payment and records why', async () => {
    const store = storeThatCreates();
    const outcome = await createPayment(INPUT, {
      store,
      providers: registryWith(
        providerReturning({ outcome: 'definitive_failure', reason: 'credential not permitted' }),
      ),
    });

    expect(outcome.kind).toBe('rejected');
    expect(store.calls.applied[0]?.toStatus).toBe('failed');
    expect(store.calls.applied[0]?.trigger).toBe('PROVIDER_REFUSED');
  });

  it('returns a safe failure to pending, so another provider could be tried', async () => {
    const store = storeThatCreates();
    await createPayment(INPUT, {
      store,
      providers: registryWith(
        providerReturning({ outcome: 'safe_failure', reason: 'the request was invalid' }),
      ),
    });

    expect(store.calls.applied[0]?.toStatus).toBe('pending');
    expect(store.calls.applied[0]?.trigger).toBe('SAFE_FAILURE_OBSERVED');
    // Still being routed, so the caller has not been answered yet.
    expect(store.calls.applied[0]?.completesRequest).toBe(false);
  });

  it('does not abandon the payment in pending once the candidates run out', async () => {
    // pending counts as live, so a payment left there holds its merchant
    // reference and the merchant can never reuse it.
    const store = storeThatCreates();
    const outcome = await createPayment(INPUT, {
      store,
      providers: registryWith(
        providerReturning({ outcome: 'safe_failure', reason: 'the request was invalid' }),
      ),
    });

    expect(store.calls.routingFailures).toHaveLength(1);
    expect(paymentOf(outcome).status).toBe('failed');
    expect(paymentOf(outcome).failureCode).toBe('all_providers_refused');
  });
});

describe('a payment whose outcome cannot be determined', () => {
  it('records unknown rather than failed, and never says the payment failed', async () => {
    // The request may have reached Appmax and may have created something payable.
    // Appmax has no idempotency key and no order search, so the only honest
    // record is that we do not know.
    const store = storeThatCreates();
    const outcome = await createPayment(INPUT, {
      store,
      providers: registryWith(
        providerReturning({
          outcome: 'unknown_outcome',
          reason: 'Appmax did not answer within the timeout.',
          providerReference: '3531',
        }),
      ),
    });

    expect(outcome.kind).toBe('uncertain');
    expect(store.calls.applied[0]).toEqual({
      outcomeClass: 'unknown_outcome',
      toStatus: 'unknown',
      trigger: 'PROVIDER_OUTCOME_UNKNOWN',
      providerReference: '3531',
      responseStatus: 202,
      completesRequest: true,
      evidenceClass: 'internal',
    });
  });

  it('never opens a second attempt after an unknown outcome', async () => {
    // Retrying here is exactly how a customer ends up with two payable codes.
    const store = storeThatCreates();
    await createPayment(INPUT, {
      store,
      providers: registryWith(providerReturning({ outcome: 'unknown_outcome', reason: 'timeout' })),
    });

    expect(store.calls.opened).toHaveLength(1);
  });

  it('carries the provider reference through, so reconciliation has something to read', async () => {
    const store = storeThatCreates();
    await createPayment(INPUT, {
      store,
      providers: registryWith(
        providerReturning({
          outcome: 'unknown_outcome',
          reason: 'unreadable response',
          providerReference: '3531',
        }),
      ),
    });

    expect(store.calls.applied[0]?.providerReference).toBe('3531');
  });
});

describe('an instrument that cannot safely be shown', () => {
  it('refuses a Pix code whose checksum does not verify', async () => {
    const store = storeThatCreates();
    const outcome = await createPayment(INPUT, {
      store,
      providers: registryOfferingCode(`${payableBrCode('10.00')}XXXX`),
    });

    expect(outcome.kind).toBe('uncertain');
    expect(store.calls.applied[0]?.outcomeClass).toBe('unknown_outcome');
    expect(paymentOf(outcome).instrument).toBeUndefined();
  });

  it('refuses a Pix code that asks for a different amount than the payment', async () => {
    // It would scan perfectly and charge the wrong sum.
    const store = storeThatCreates();
    const outcome = await createPayment(INPUT, {
      store,
      providers: registryOfferingCode(payableBrCode('99.00')),
    });

    expect(outcome.kind).toBe('uncertain');
    expect(reasonOf(outcome)).toContain('asks for');
    expect(paymentOf(outcome).instrument).toBeUndefined();
  });
});

describe('the status stored for a replay is the status the caller received', () => {
  // Storing 201 while answering 202 would make a replayed uncertain payment look
  // created, which is the one thing idempotency exists to prevent.
  it.each([
    ['success', GOOD_INSTRUMENT],
    ['unknown', { outcome: 'unknown_outcome' as const, reason: 'timeout' }],
    ['refused', { outcome: 'definitive_failure' as const, reason: 'refused' }],
  ])('stores exactly what it returns for a %s outcome', async (_label, result) => {
    const store = storeThatCreates();
    const outcome = await createPayment(INPUT, {
      store,
      providers: registryWith(providerReturning(result)),
    });

    if (!('responseStatus' in outcome)) {
      throw new Error(`expected an outcome carrying a response status, got ${outcome.kind}`);
    }
    expect(store.calls.applied[0]?.responseStatus).toBe(outcome.responseStatus);
  });
});

describe('idempotency reaches the caller unchanged', () => {
  it('replays without calling a provider at all', async () => {
    const store: PaymentCreationStore = {
      createPayment: () =>
        Promise.resolve({
          kind: 'replayed' as const,
          responseStatus: 201,
          responseBody: { id: 'pay_previous' },
        }),
      openAttempt: () => Promise.reject(new Error('must not open an attempt on a replay')),
      applyProviderOutcome: () => Promise.reject(new Error('must not apply an outcome')),
      failRouting: () => Promise.reject(new Error('must not fail routing on a replay')),
    };

    const outcome = await createPayment(INPUT, {
      store,
      providers: registryWith(providerReturning(GOOD_INSTRUMENT)),
    });

    expect(outcome).toEqual({
      kind: 'replayed',
      responseStatus: 201,
      responseBody: { id: 'pay_previous' },
    });
  });

  it.each([
    ['conflict', 'idempotency_conflict'],
    ['in_flight', 'in_flight'],
    ['duplicate_merchant_reference', 'duplicate_merchant_reference'],
  ])('surfaces %s without contacting a provider', async (storeKind, expected) => {
    const store: PaymentCreationStore = {
      createPayment: () => Promise.resolve({ kind: storeKind } as never),
      openAttempt: () => Promise.reject(new Error('must not open an attempt')),
      applyProviderOutcome: () => Promise.reject(new Error('must not apply an outcome')),
      failRouting: () => Promise.reject(new Error('must not fail routing')),
    };

    const outcome = await createPayment(INPUT, {
      store,
      providers: registryWith(providerReturning(GOOD_INSTRUMENT)),
    });

    expect(outcome.kind).toBe(expected);
  });
});

describe('provider selection', () => {
  it('reports that nothing can serve the payment rather than throwing', async () => {
    const outcome = await createPayment(
      { ...INPUT, currency: 'USD' },
      { store: storeThatCreates(), providers: registryWith(providerReturning(GOOD_INSTRUMENT)) },
    );

    expect(outcome.kind).toBe('no_provider');
  });

  it('offers nothing when no provider is registered at all', async () => {
    const outcome = await createPayment(INPUT, {
      store: storeThatCreates(),
      providers: new ProviderRegistry([]),
    });

    expect(outcome.kind).toBe('no_provider');
  });

  it('releases the idempotency claim instead of stranding it', async () => {
    // Returning without resolving the claim left the key answering "still being
    // processed" to every retry forever, and the payment holding the merchant
    // reference against a payment that would never go anywhere.
    const store = storeThatCreates();
    const outcome = await createPayment(INPUT, {
      store,
      providers: new ProviderRegistry([]),
    });

    expect(store.calls.routingFailures).toHaveLength(1);
    expect(store.calls.routingFailures[0]?.paymentId).toBe('internal-1');
    expect(store.calls.routingFailures[0]?.responseStatus).toBe(422);
    expect(paymentOf(outcome).status).toBe('failed');
    expect(paymentOf(outcome).failureCode).toBe('no_provider_available');
  });

  it('never contacts a provider or opens an attempt when nothing can serve it', async () => {
    const store = storeThatCreates();
    await createPayment(INPUT, { store, providers: new ProviderRegistry([]) });

    expect(store.calls.opened).toHaveLength(0);
    expect(store.calls.applied).toHaveLength(0);
  });
});

describe('a payment that did not succeed says why', () => {
  it('names the code and the reason on a refusal', async () => {
    const outcome = await createPayment(INPUT, {
      store: storeThatCreates(),
      providers: registryWith(
        providerReturning({ outcome: 'definitive_failure', reason: 'credential not permitted' }),
      ),
    });

    expect(paymentOf(outcome).failureCode).toBe('provider_rejected');
    expect(paymentOf(outcome).failureReason).toBe('credential not permitted');
  });

  it('names the code on an uncertain outcome', async () => {
    const outcome = await createPayment(INPUT, {
      store: storeThatCreates(),
      providers: registryWith(
        providerReturning({ outcome: 'unknown_outcome', reason: 'no answer in time' }),
      ),
    });

    expect(paymentOf(outcome).failureCode).toBe('provider_outcome_unknown');
  });

  it('says nothing about failure on a payment that succeeded', async () => {
    const outcome = await createPayment(INPUT, {
      store: storeThatCreates(),
      providers: registryWith(providerReturning(GOOD_INSTRUMENT)),
    });

    expect(paymentOf(outcome).failureCode).toBeUndefined();
    expect(paymentOf(outcome).failureReason).toBeUndefined();
  });
});

function registryOf(...providers: PixPaymentProvider[]): ProviderRegistry {
  return new ProviderRegistry(
    providers.map((provider, index) => ({
      descriptor: provider.descriptor,
      environment: 'SANDBOX' as const,
      pix: provider,
      priority: index + 1,
    })),
  );
}

function namedProvider(code: string, result: ProviderResult<PixInstrument>): PixPaymentProvider {
  return {
    descriptor: { ...TEST_DESCRIPTOR, code },
    createPixInstrument: () => Promise.resolve(result),
    readPaymentState: () =>
      Promise.resolve({ outcome: 'unknown_outcome' as const, reason: 'not used here' }),
  };
}

describe('failing over to another provider', () => {
  it('tries the next provider after a safe failure and succeeds there', async () => {
    const store = storeThatCreates();
    const outcome = await createPayment(INPUT, {
      store,
      providers: registryOf(
        namedProvider('first', { outcome: 'safe_failure', reason: 'refused, created nothing' }),
        namedProvider('second', GOOD_INSTRUMENT),
      ),
    });

    expect(outcome.kind).toBe('created');
    expect(store.calls.opened.map((call) => call.providerCode)).toEqual(['first', 'second']);
    // Attempt numbers are distinct: the schema refuses a duplicate on one payment.
    expect(store.calls.opened.map((call) => call.attemptNumber)).toEqual([1, 2]);
    expect(store.calls.applied[1]?.completesRequest).toBe(true);
  });

  it('never tries another provider after an unknown outcome', async () => {
    // The first provider may have created something payable. Trying the next one
    // is exactly how a customer ends up holding two payable codes.
    const store = storeThatCreates();
    const outcome = await createPayment(INPUT, {
      store,
      providers: registryOf(
        namedProvider('first', { outcome: 'unknown_outcome', reason: 'timed out' }),
        namedProvider('second', GOOD_INSTRUMENT),
      ),
    });

    expect(outcome.kind).toBe('uncertain');
    expect(store.calls.opened).toHaveLength(1);
    expect(store.calls.opened[0]?.providerCode).toBe('first');
  });

  it('never tries another provider after a definitive refusal', async () => {
    const store = storeThatCreates();
    const outcome = await createPayment(INPUT, {
      store,
      providers: registryOf(
        namedProvider('first', { outcome: 'definitive_failure', reason: 'refused outright' }),
        namedProvider('second', GOOD_INSTRUMENT),
      ),
    });

    expect(outcome.kind).toBe('rejected');
    expect(store.calls.opened).toHaveLength(1);
  });

  it('closes the payment when every candidate refuses', async () => {
    const store = storeThatCreates();
    const outcome = await createPayment(INPUT, {
      store,
      providers: registryOf(
        namedProvider('first', { outcome: 'safe_failure', reason: 'first refused' }),
        namedProvider('second', { outcome: 'safe_failure', reason: 'second refused' }),
      ),
    });

    expect(store.calls.opened).toHaveLength(2);
    expect(store.calls.routingFailures).toHaveLength(1);
    expect(outcome.kind).toBe('no_provider');
    expect(paymentOf(outcome).status).toBe('failed');
  });
});

describe('a transport failure that never reached the provider', () => {
  it('is not audited as a refusal the provider never made', async () => {
    // PROVIDER_REFUSED on an authenticated read would record a conversation that
    // never happened, against a provider that never saw the request.
    const store = storeThatCreates();
    await createPayment(INPUT, {
      store,
      providers: registryWith(
        providerReturning({
          outcome: 'retryable_transport_failure',
          reason: 'the connection was refused',
        }),
      ),
    });

    expect(store.calls.applied[0]?.toStatus).toBe('pending');
    expect(store.calls.applied[0]?.trigger).toBe('SAFE_FAILURE_OBSERVED');
    expect(store.calls.applied[0]?.evidenceClass).toBe('internal');
  });

  it('moves on to the next provider, because nothing was created', async () => {
    const store = storeThatCreates();
    const outcome = await createPayment(INPUT, {
      store,
      providers: registryOf(
        namedProvider('first', {
          outcome: 'retryable_transport_failure',
          reason: 'connection refused',
        }),
        namedProvider('second', GOOD_INSTRUMENT),
      ),
    });

    expect(outcome.kind).toBe('created');
    expect(store.calls.opened).toHaveLength(2);
  });
});

describe('an adapter that throws', () => {
  it('becomes an unknown outcome rather than escaping the use case', async () => {
    // An escaping exception would unwind past the point where the attempt is
    // closed, leaving the payment in processing and its claim open forever.
    const store = storeThatCreates();
    const thrower: PixPaymentProvider = {
      descriptor: TEST_DESCRIPTOR,
      createPixInstrument: () => Promise.reject(new Error('the token endpoint returned 503')),
      readPaymentState: () =>
        Promise.resolve({ outcome: 'unknown_outcome' as const, reason: 'not used' }),
    };

    const outcome = await createPayment(INPUT, { store, providers: registryWith(thrower) });

    expect(outcome.kind).toBe('uncertain');
    expect(store.calls.applied[0]?.outcomeClass).toBe('unknown_outcome');
    expect(store.calls.applied[0]?.completesRequest).toBe(true);
    expect(reasonOf(outcome)).toContain('503');
  });

  it('does not try another provider after a throw, because nothing is known', async () => {
    const store = storeThatCreates();
    const thrower: PixPaymentProvider = {
      descriptor: { ...TEST_DESCRIPTOR, code: 'first' },
      createPixInstrument: () => Promise.reject(new Error('boom')),
      readPaymentState: () =>
        Promise.resolve({ outcome: 'unknown_outcome' as const, reason: 'not used' }),
    };

    await createPayment(INPUT, {
      store,
      providers: registryOf(thrower, namedProvider('second', GOOD_INSTRUMENT)),
    });

    expect(store.calls.opened).toHaveLength(1);
  });
});

describe('a provider is bound to the environment its credentials belong to', () => {
  it('never serves a production payment from a sandbox registration', async () => {
    // A sandbox code cannot be paid. Handing one to a production payment would
    // tell a merchant their customer had something to pay when they had not.
    const store = storeThatCreates();
    const outcome = await createPayment(
      { ...INPUT, environment: 'PRODUCTION' },
      { store, providers: registryWith(providerReturning(GOOD_INSTRUMENT)) },
    );

    expect(outcome.kind).toBe('no_provider');
    expect(store.calls.opened).toHaveLength(0);
    expect(reasonOf(outcome)).toContain('PRODUCTION');
  });

  it('serves a sandbox payment from the sandbox registration', async () => {
    const outcome = await createPayment(INPUT, {
      store: storeThatCreates(),
      providers: registryWith(providerReturning(GOOD_INSTRUMENT)),
    });

    expect(outcome.kind).toBe('created');
  });
});
