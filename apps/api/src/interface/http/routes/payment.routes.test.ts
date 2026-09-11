import { generateApiKey, hashApiKeySecret, Secret } from '@gateway/shared/server';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { systemClock } from '../../../application/authenticate-api-key.js';
import type {
  PaymentCreationStore,
  PaymentView,
} from '../../../application/create-payment.use-case.js';
import type { StoredApiKey } from '../../../application/ports/api-key.repository.js';
import type {
  CryptoInstrument,
  CryptoPaymentProvider,
  PixInstrument,
  PixPaymentProvider,
  ProviderResult,
} from '../../../application/ports/payment-provider.js';
import type { PaymentSnapshot } from '../../../application/ports/payment-read.repository.js';
import type { PaymentDetail } from '../../../application/read-payment.use-case.js';
import { ProviderRegistry } from '../../../application/provider-registry.js';
import type { ApiKeyScope } from '../../../domain/api-key/api-key.js';
import { payableBrCode } from '../../../domain/pix/br-code.test-support.js';
import type { ProviderDescriptor } from '../../../domain/provider/provider-capability.js';
import type { ApiErrorBody } from '../errors.js';
import { registerErrorHandling } from '../error-handling.js';
import { registerPaymentRoutes } from './payment.routes.js';
import type { ApplicationServer } from '../server-types.js';

/**
 * Drives the route through Fastify's injector, so the real routing, parsing and
 * serialization run. The store and the provider are stand-ins, but the use case,
 * the registry and the outcome mapping are the real ones: what is under test is
 * that the HTTP layer stays thin and reports each outcome faithfully.
 */

const TEST_DESCRIPTOR: ProviderDescriptor = {
  code: 'test-provider',
  displayName: 'Test Provider',
  capabilities: ['pix.create', 'pix.status'],
  supportedCurrencies: ['BRL'],
  instrumentCreationIsIdempotent: false,
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

const CRYPTO_DESCRIPTOR: ProviderDescriptor = {
  code: 'test-crypto',
  displayName: 'Test Crypto',
  capabilities: ['crypto.create', 'crypto.status'],
  supportedCurrencies: ['USDC'],
  supportedNetworks: ['polygon'],
  instrumentCreationIsIdempotent: true,
};

const GOOD_CRYPTO_INSTRUMENT: ProviderResult<CryptoInstrument> = {
  outcome: 'success',
  providerReference: 'pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
  value: {
    network: 'polygon',
    asset: 'USDC',
    destinationAddress: '0x1077840bd639dbd769cb7dde82235d265e73f28a',
    paymentUri: 'ethereum:0x5fbd@31337/transfer?address=0x1077&uint256=1500000',
    qrCodeImageDataUri: 'data:image/png;base64,BBBB',
    amountMinor: 1_500_000n,
    expiresAt: new Date('2026-09-09T18:30:00.000Z'),
  },
};

function cryptoProviderReturning(
  result: ProviderResult<CryptoInstrument>,
): CryptoPaymentProvider & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    descriptor: CRYPTO_DESCRIPTOR,
    createCryptoInstrument: (request) => {
      requests.push(request);
      return Promise.resolve(result);
    },
    readPaymentState: () =>
      Promise.resolve({ outcome: 'unknown_outcome' as const, reason: 'not used here' }),
  };
}

const SNAPSHOT: PaymentSnapshot = {
  publicId: 'pay_0123456789abcdefghjkmnpqrs',
  status: 'paid',
  paymentMethod: 'crypto',
  environment: 'SANDBOX',
  currency: 'USDC',
  expectedAmountMinor: 1_500_000n,
  capturedAmountMinor: 1_500_000n,
  merchantReference: 'order-1',
  createdAt: new Date('2026-09-11T00:00:00.000Z'),
  updatedAt: new Date('2026-09-11T00:05:00.000Z'),
  expiresAt: new Date('2026-09-11T00:30:00.000Z'),
  paidAt: new Date('2026-09-11T00:04:00.000Z'),
  providerCode: 'cryptopay',
  providerReference: 'pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
  instrument: {
    type: 'crypto',
    network: 'polygon',
    asset: 'USDC',
    destinationAddress: '0x1077840bd639dbd769cb7dde82235d265e73f28a',
    paymentUri: 'ethereum:0x5fbd@31337/transfer?address=0x1077&uint256=1500000',
    qrCodeImageDataUri: 'data:image/png;base64,BBBB',
  },
  transitions: [
    {
      sequence: 3,
      fromStatus: 'awaiting_payment',
      toStatus: 'paid',
      trigger: 'PAYMENT_CONFIRMED',
      evidenceClass: 'authenticated_provider_read',
      reason: 'Provider reported PAID.',
      occurredAt: new Date('2026-09-11T00:04:00.000Z'),
    },
  ],
  providerNotifications: [
    {
      provider: 'cryptopay',
      eventType: 'payment.completed',
      receivedAt: new Date('2026-09-11T00:03:59.000Z'),
      disposition: 'scheduled_read',
    },
  ],
  events: [
    {
      type: 'payment.paid',
      occurredAt: new Date('2026-09-11T00:04:00.000Z'),
      deliveryStatus: 'delivered',
      deliveryReference: 'notification-1',
      attempts: 1,
      publishedAt: new Date('2026-09-11T00:04:02.000Z'),
      lastFailure: undefined,
    },
  ],
};

function providerReturning(result: ProviderResult<PixInstrument>): PixPaymentProvider {
  return {
    descriptor: TEST_DESCRIPTOR,
    createPixInstrument: () => Promise.resolve(result),
    readPaymentState: () =>
      Promise.resolve({ outcome: 'unknown_outcome' as const, reason: 'not used here' }),
  };
}

type ClaimResult = Awaited<ReturnType<PaymentCreationStore['createPayment']>>;

const CLAIM_CREATED: ClaimResult = {
  kind: 'created',
  paymentId: 'internal-1',
  publicId: 'pay_0123456789abcdefghjkmnpqrs',
};

const PEPPER = new Secret('a-pepper-for-route-tests-only');

const VALID_BODY = {
  amount: 1000,
  currency: 'BRL',
  paymentMethod: 'pix',
  reference: 'order-1',
  description: 'A digital thing',
  customer: {
    firstName: 'Junior',
    lastName: 'Almeida',
    email: 'junior@example.com',
    phone: '51983655100',
    documentNumber: '25226493029',
  },
};

interface Harness {
  readonly server: ApplicationServer;
  readonly plaintextKey: string;
  readonly received: unknown[];
  readonly reads: unknown[];
  readonly outcomes: unknown[];
}

function buildHarness(options: {
  scopes?: ApiKeyScope[];
  environment?: 'SANDBOX' | 'PRODUCTION';
  revoked?: boolean;
  providerResult?: ProviderResult<PixInstrument>;
  /**
   * Makes the store throw, standing in for anything below the route failing.
   */
  storeThrows?: Error;
  /**
   * Omitted entirely to test the "no provider is configured" path.
   */
  withoutProvider?: boolean;
  claim?: ClaimResult;
  cryptoProvider?: CryptoPaymentProvider;
  /**
   * What a read finds. The query is recorded so scoping can be asserted.
   */
  snapshot?: PaymentSnapshot;
}): Harness {
  const generated = generateApiKey(options.environment ?? 'SANDBOX');
  const stored: StoredApiKey = {
    apiKeyId: 'api-key-1',
    organizationId: 'organization-1',
    environment: options.environment ?? 'SANDBOX',
    keyHash: hashApiKeySecret(generated.identifier, generated.secret, PEPPER),
    scopes: options.scopes ?? ['payments:write'],
    revokedAt: options.revoked === true ? new Date('2020-01-01') : null,
    expiresAt: null,
    organizationArchivedAt: null,
  };

  const received: unknown[] = [];
  const reads: unknown[] = [];
  const outcomes: unknown[] = [];
  const server = Fastify() as unknown as ApplicationServer;
  registerErrorHandling(server);

  const provider = providerReturning(options.providerResult ?? GOOD_INSTRUMENT);
  const providers =
    options.withoutProvider === true
      ? new ProviderRegistry([])
      : new ProviderRegistry([
          {
            descriptor: provider.descriptor,
            // Matches the key environment the harness issues, so selection is
            // exercised rather than skipped.
            environment: options.environment ?? 'SANDBOX',
            pix: provider,
            priority: 1,
          },
          ...(options.cryptoProvider === undefined
            ? []
            : [
                {
                  descriptor: options.cryptoProvider.descriptor,
                  environment: options.environment ?? 'SANDBOX',
                  crypto: options.cryptoProvider,
                  priority: 1,
                },
              ]),
        ]);

  registerPaymentRoutes(server, {
    paymentReads: {
      store: {
        findByPublicId: (query) => {
          reads.push(query);
          return Promise.resolve(
            options.snapshot !== undefined && query.publicId === options.snapshot.publicId
              ? options.snapshot
              : undefined,
          );
        },
      },
    },
    authentication: {
      repository: {
        findByIdentifier: (identifier) =>
          Promise.resolve(identifier === generated.identifier ? stored : undefined),
        recordUse: () => Promise.resolve(),
      },
      pepper: PEPPER,
      clock: systemClock,
    },
    payments: {
      store: {
        createPayment: (command) => {
          received.push(command);
          if (options.storeThrows !== undefined) {
            return Promise.reject(options.storeThrows);
          }
          return Promise.resolve(options.claim ?? CLAIM_CREATED);
        },
        openAttempt: () => Promise.resolve('attempt-1'),
        applyProviderOutcome: (command) => {
          outcomes.push(command);
          return Promise.resolve();
        },
        failRouting: () => Promise.resolve(),
      },
      providers,
    },
  });

  return { server, plaintextKey: generated.plaintext.expose(), received, reads, outcomes };
}

async function get(harness: Harness, options: { key?: string; paymentId: string }) {
  return harness.server.inject({
    method: 'GET',
    url: `/v1/payments/${options.paymentId}`,
    headers: {
      ...(options.key !== undefined && { authorization: `Bearer ${options.key}` }),
    },
  });
}

async function post(
  harness: Harness,
  options: { key?: string; idempotencyKey?: string; body?: unknown },
) {
  return harness.server.inject({
    method: 'POST',
    url: '/v1/payments',
    headers: {
      ...(options.key !== undefined && { authorization: `Bearer ${options.key}` }),
      ...(options.idempotencyKey !== undefined && { 'idempotency-key': options.idempotencyKey }),
      'content-type': 'application/json',
    },
    payload: options.body ?? VALID_BODY,
  });
}

type InjectedResponse = Awaited<ReturnType<typeof post>>;

/**
 * `json()` is untyped by design, and reading it as `any` would let an assertion
 * pass against a field the response does not have. Both readers name the shape
 * the route actually promises.
 */
function errorOf(response: InjectedResponse): ApiErrorBody['error'] {
  return response.json<ApiErrorBody>().error;
}

function paymentOf(response: InjectedResponse): PaymentView {
  return response.json<PaymentView>();
}

describe('authentication', () => {
  it('refuses a request with no API key', async () => {
    const harness = buildHarness({});
    const response = await post(harness, { idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(401);
    expect(errorOf(response).code).toBe('invalid_api_key');
  });

  it('refuses a malformed key', async () => {
    const harness = buildHarness({});
    const response = await post(harness, { key: 'not-a-key', idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(401);
  });

  it('refuses a revoked key with the same answer as an unknown one', async () => {
    // Distinguishing them would turn the endpoint into a probe for real keys.
    const revoked = buildHarness({ revoked: true });
    const unknown = buildHarness({});

    const revokedResponse = await post(revoked, {
      key: revoked.plaintextKey,
      idempotencyKey: 'key-1',
    });
    const unknownResponse = await post(unknown, {
      key: generateApiKey('SANDBOX').plaintext.expose(),
      idempotencyKey: 'key-1',
    });

    expect(revokedResponse.statusCode).toBe(unknownResponse.statusCode);
    expect(errorOf(revokedResponse).code).toBe(errorOf(unknownResponse).code);
  });

  it('never echoes the presented key back', async () => {
    const harness = buildHarness({});
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.body).not.toContain(harness.plaintextKey);
  });
});

describe('authorization', () => {
  it('refuses a key without the payments:write scope', async () => {
    const harness = buildHarness({ scopes: ['payments:read'] });
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('insufficient_scope');
  });
});

describe('request validation', () => {
  it('requires an idempotency key', async () => {
    const harness = buildHarness({});
    const response = await post(harness, { key: harness.plaintextKey });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('missing_idempotency_key');
  });

  it('refuses a fractional amount rather than rounding it', async () => {
    // A caller sending 19.99 believes this API takes major units.
    const harness = buildHarness({});
    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: { ...VALID_BODY, amount: 19.99 },
    });

    expect(response.statusCode).toBe(422);
    expect(errorOf(response).param).toBe('amount');
  });

  it('refuses a zero or negative amount', async () => {
    const harness = buildHarness({});
    for (const amount of [0, -100]) {
      const response = await post(harness, {
        key: harness.plaintextKey,
        idempotencyKey: 'key-1',
        body: { ...VALID_BODY, amount },
      });
      expect(response.statusCode).toBe(422);
    }
  });

  it('refuses an unsupported currency', async () => {
    const harness = buildHarness({});
    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: { ...VALID_BODY, currency: 'USD' },
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses an unknown field instead of silently ignoring it', async () => {
    // A stripped key is an ignored instruction. A merchant who sends `ammount`
    // deserves to be told rather than charged the default.
    const harness = buildHarness({});
    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: { ...VALID_BODY, ammount: 5000 },
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses an over-long idempotency key at the edge', async () => {
    // The column is bounded at 255. Unchecked, this reached the database and came
    // back as a constraint violation, which the caller saw as a 500 for their own
    // input.
    const harness = buildHarness({});
    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'k'.repeat(256),
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).param).toBe('Idempotency-Key');
  });

  it('accepts an idempotency key exactly at the limit', async () => {
    const harness = buildHarness({});
    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'k'.repeat(255),
    });

    expect(response.statusCode).not.toBe(400);
  });

  it('refuses a reference that is only whitespace', async () => {
    // Measured raw, "   " passed here and was refused by the database instead,
    // which the caller saw as a 500.
    const harness = buildHarness({});
    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: { ...VALID_BODY, reference: ' '.repeat(3) },
    });

    expect(response.statusCode).toBe(422);
  });

  it('trims the reference before it is stored', async () => {
    // Otherwise " order-1" and "order-1" each hold their own live payment against
    // an index meant to permit one.
    const harness = buildHarness({});
    await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: { ...VALID_BODY, reference: '  order-1  ' },
    });

    expect(harness.received[0]).toMatchObject({ merchantReference: 'order-1' });
  });

  it('carries the request id into every error body', async () => {
    const harness = buildHarness({});
    const response = await post(harness, { idempotencyKey: 'key-1' });

    expect(errorOf(response).requestId).toBeTruthy();
    expect(response.headers['x-request-id']).toBeUndefined();
  });
});

describe('the environment comes from the key, never the body', () => {
  it.each(['SANDBOX', 'PRODUCTION'] as const)(
    'uses the %s key environment',
    async (environment) => {
      const harness = buildHarness({ environment });
      await post(harness, {
        key: harness.plaintextKey,
        idempotencyKey: 'key-1',
        body: { ...VALID_BODY },
      });

      expect(harness.received[0]).toMatchObject({ environment, organizationId: 'organization-1' });
    },
  );

  it('ignores an environment supplied in the body', async () => {
    // A caller must not be able to ask for production by saying so. The field is
    // not in the schema, so it is refused outright rather than quietly ignored.
    const harness = buildHarness({ environment: 'SANDBOX' });
    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: { ...VALID_BODY, environment: 'PRODUCTION' },
    });

    expect(response.statusCode).toBe(422);
    expect(harness.received).toHaveLength(0);
  });
});

describe('nothing internal escapes', () => {
  it('answers a failure below the route with the documented envelope', async () => {
    // Fastify's default handler returns the exception's own message, which for a
    // driver error names the schema and sometimes the connection string.
    const harness = buildHarness({
      storeThrows: new Error('duplicate key value violates unique constraint "payments_pkey"'),
    });
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(500);
    expect(errorOf(response).code).toBe('internal_error');
    expect(errorOf(response).requestId).toBeTruthy();

    expect(response.body).not.toContain('payments_pkey');
    expect(response.body).not.toContain('unique constraint');
  });

  it('answers an unknown path in the same envelope as everything else', async () => {
    const harness = buildHarness({});
    const response = await harness.server.inject({ method: 'POST', url: '/v1/nope' });

    expect(response.statusCode).toBe(404);
    expect(errorOf(response).code).toBe('not_found');
  });

  it('refuses a body that is not JSON without echoing it back', async () => {
    const harness = buildHarness({});
    const response = await harness.server.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: {
        authorization: `Bearer ${harness.plaintextKey}`,
        'idempotency-key': 'key-1',
        'content-type': 'application/json',
      },
      payload: '{"amount": 1000, oops',
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).type).toBe('invalid_request_error');
    expect(response.body).not.toContain('oops');
  });
});

describe('the outcome mapping', () => {
  it('answers 201 with the instrument when the provider issues one', async () => {
    const harness = buildHarness({});
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(201);
    const body = paymentOf(response);
    expect(body.status).toBe('awaiting_payment');
    expect(body.instrument?.type).toBe('pix');
    expect(body.instrument?.type === 'pix' && body.instrument.copyAndPasteCode).toBe(
      payableBrCode('10.00'),
    );
    // A JSON number cannot hold every amount this gateway accepts without losing
    // precision, so money crosses the wire as a string.
    expect(body.amountMinor).toBe('1000');
    expect(typeof body.amountMinor).toBe('string');
  });

  it('answers 202, not an error, when the provider outcome is unknown', async () => {
    // The request may have reached the provider and may have created something
    // payable. Reporting a failure would tell the merchant nothing happened when
    // something may well have; 202 says "accepted, not yet resolved".
    const harness = buildHarness({
      providerResult: { outcome: 'unknown_outcome', reason: 'no answer within the timeout' },
    });
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(202);
    expect(paymentOf(response).status).toBe('unknown');
  });

  it('never presents an instrument alongside an unknown outcome', async () => {
    const harness = buildHarness({
      providerResult: { outcome: 'unknown_outcome', reason: 'unreadable response' },
    });
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(paymentOf(response).instrument).toBeUndefined();
  });

  it('answers 402 when the provider definitively refuses', async () => {
    const harness = buildHarness({
      providerResult: { outcome: 'definitive_failure', reason: 'refused' },
    });
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(402);
    expect(paymentOf(response).status).toBe('failed');
  });

  it('never shows a Pix code that asks for a different amount than the payment', async () => {
    // It would scan perfectly and charge the wrong sum.
    const harness = buildHarness({
      providerResult: {
        outcome: 'success',
        providerReference: '3531',
        value: {
          copyAndPasteCode: payableBrCode('99.00'),
          qrCodeImageDataUri: undefined,
          expiresAt: undefined,
        },
      },
    });
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(202);
    expect(paymentOf(response).instrument).toBeUndefined();
  });

  it('reports that no provider can serve the payment rather than failing obscurely', async () => {
    // A payment row exists, so the caller gets a payment carrying why it failed
    // rather than a bare error. The same body is stored, so a retry with the same
    // key replays it instead of being told the request is still running.
    const harness = buildHarness({ withoutProvider: true });
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(422);
    expect(paymentOf(response).status).toBe('failed');
    expect(paymentOf(response).failureCode).toBe('no_provider_available');
  });
});

describe('idempotency reaches the caller unchanged', () => {
  it('replays the stored response with its original status', async () => {
    const harness = buildHarness({
      claim: { kind: 'replayed', responseStatus: 201, responseBody: { id: 'pay_previous' } },
    });
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(201);
    expect(response.json<unknown>()).toEqual({ id: 'pay_previous' });
  });

  it('answers 409 and marks it retryable while the first request is still running', async () => {
    const harness = buildHarness({ claim: { kind: 'in_flight' } });
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('idempotency_key_in_flight');
    expect(errorOf(response).retryable).toBe(true);
  });

  it('answers 422 when the same key arrives with a different request', async () => {
    const harness = buildHarness({ claim: { kind: 'conflict' } });
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(422);
    expect(errorOf(response).code).toBe('idempotency_key_reuse');
  });

  it('answers 409 when a live payment already exists for the reference', async () => {
    const harness = buildHarness({ claim: { kind: 'duplicate_merchant_reference' } });
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('duplicate_merchant_reference');
  });
});

describe('crypto payments', () => {
  const CRYPTO_BODY = {
    amount: 1_500_000,
    currency: 'USDC',
    paymentMethod: 'crypto',
    reference: 'order-1',
    description: 'A digital thing',
    customer: { phone: '+5515999998888' },
  };

  it('answers 201 with the destination, the URI and the QR code', async () => {
    const provider = cryptoProviderReturning(GOOD_CRYPTO_INSTRUMENT);
    const harness = buildHarness({ cryptoProvider: provider });

    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: CRYPTO_BODY,
    });

    expect(response.statusCode).toBe(201);
    const body = paymentOf(response);
    expect(body.paymentMethod).toBe('crypto');
    expect(body.status).toBe('awaiting_payment');
    expect(body.currency).toBe('USDC');
    expect(body.amountMinor).toBe('1500000');
    expect(body.instrument).toEqual({
      type: 'crypto',
      network: 'polygon',
      asset: 'USDC',
      destinationAddress: '0x1077840bd639dbd769cb7dde82235d265e73f28a',
      paymentUri: 'ethereum:0x5fbd@31337/transfer?address=0x1077&uint256=1500000',
      qrCodeImageDataUri: 'data:image/png;base64,BBBB',
      expiresAt: '2026-09-09T18:30:00.000Z',
    });

    // The provider is asked to correlate on our payment id and to deduplicate
    // on our idempotency key; the phone stays with us for the paid event.
    expect(provider.requests[0]).toMatchObject({
      paymentId: 'pay_0123456789abcdefghjkmnpqrs',
      merchantReference: 'order-1',
      idempotencyKey: 'key-1',
      amountMinor: 1_500_000n,
      currency: 'USDC',
    });
    expect(harness.received[0]).toMatchObject({
      paymentMethod: 'crypto',
      customerPhone: '+5515999998888',
    });
    expect(harness.outcomes[0]).toMatchObject({
      providerReference: 'pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
      instrument: { type: 'crypto' },
    });
  });

  it('needs no customer at all', async () => {
    const harness = buildHarness({
      cryptoProvider: cryptoProviderReturning(GOOD_CRYPTO_INSTRUMENT),
    });
    const withoutCustomer = Object.fromEntries(
      Object.entries(CRYPTO_BODY).filter(([field]) => field !== 'customer'),
    );

    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: withoutCustomer,
    });

    expect(response.statusCode).toBe(201);
    expect(harness.received[0]).toMatchObject({ customerPhone: undefined });
  });

  it('refuses a phone that is not international', async () => {
    const harness = buildHarness({
      cryptoProvider: cryptoProviderReturning(GOOD_CRYPTO_INSTRUMENT),
    });

    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: { ...CRYPTO_BODY, customer: { phone: '15999998888' } },
    });

    expect(response.statusCode).toBe(422);
    expect(errorOf(response).param).toBe('customer.phone');
  });

  it('still requires the full customer for pix', async () => {
    const harness = buildHarness({});

    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: { ...VALID_BODY, customer: { phone: '+5515999998888' } },
    });

    expect(response.statusCode).toBe(422);
  });

  it('never shows a destination that asks for a different amount', async () => {
    const harness = buildHarness({
      cryptoProvider: cryptoProviderReturning({
        ...GOOD_CRYPTO_INSTRUMENT,
        value: { ...GOOD_CRYPTO_INSTRUMENT.value, amountMinor: 1_600_000n },
      }),
    });

    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: CRYPTO_BODY,
    });

    expect(response.statusCode).toBe(202);
    expect(paymentOf(response).status).toBe('unknown');
    expect(paymentOf(response).instrument).toBeUndefined();
  });

  it('reports no provider when only pix is configured', async () => {
    const harness = buildHarness({});

    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: CRYPTO_BODY,
    });

    expect(response.statusCode).toBe(422);
    expect(paymentOf(response).failureCode).toBe('no_provider_available');
  });
});

describe('reading a payment', () => {
  it('requires the payments:read scope', async () => {
    const harness = buildHarness({ scopes: ['payments:write'], snapshot: SNAPSHOT });

    const response = await get(harness, {
      key: harness.plaintextKey,
      paymentId: SNAPSHOT.publicId,
    });

    expect(response.statusCode).toBe(403);
    expect(harness.reads).toHaveLength(0);
  });

  it('answers with the gateway record and its three histories', async () => {
    const harness = buildHarness({ scopes: ['payments:read'], snapshot: SNAPSHOT });

    const response = await get(harness, {
      key: harness.plaintextKey,
      paymentId: SNAPSHOT.publicId,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<PaymentDetail>();
    expect(body.id).toBe(SNAPSHOT.publicId);
    expect(body.status).toBe('paid');
    expect(body.capturedAmountMinor).toBe('1500000');
    expect(body.paidAt).toBe('2026-09-11T00:04:00.000Z');
    expect(body.provider).toBe('cryptopay');
    expect(body.instrument?.type).toBe('crypto');
    expect(body.transitions[0]).toEqual({
      sequence: 3,
      fromStatus: 'awaiting_payment',
      toStatus: 'paid',
      trigger: 'PAYMENT_CONFIRMED',
      evidenceClass: 'authenticated_provider_read',
      reason: 'Provider reported PAID.',
      occurredAt: '2026-09-11T00:04:00.000Z',
    });
    expect(body.providerNotifications[0]?.disposition).toBe('scheduled_read');
    expect(body.events[0]?.delivery).toEqual({
      channel: 'whatsapp',
      status: 'delivered',
      attempts: 1,
      reference: 'notification-1',
      publishedAt: '2026-09-11T00:04:02.000Z',
    });
  });

  it('scopes the read by the key, never by the caller', async () => {
    const harness = buildHarness({
      scopes: ['payments:read'],
      environment: 'PRODUCTION',
      snapshot: SNAPSHOT,
    });

    await get(harness, { key: harness.plaintextKey, paymentId: SNAPSHOT.publicId });

    expect(harness.reads[0]).toEqual({
      organizationId: 'organization-1',
      environment: 'PRODUCTION',
      publicId: SNAPSHOT.publicId,
    });
  });

  it('answers 404 for a payment it does not find', async () => {
    const harness = buildHarness({ scopes: ['payments:read'] });

    const response = await get(harness, {
      key: harness.plaintextKey,
      paymentId: 'pay_0123456789abcdefghjkmnpqrs',
    });

    expect(response.statusCode).toBe(404);
    expect(errorOf(response).code).toBe('payment_not_found');
  });

  it('answers an identifier that could not be one exactly like a missing one', async () => {
    const harness = buildHarness({ scopes: ['payments:read'], snapshot: SNAPSHOT });

    const response = await get(harness, { key: harness.plaintextKey, paymentId: 'not-an-id' });

    expect(response.statusCode).toBe(404);
    expect(errorOf(response).code).toBe('payment_not_found');
    expect(harness.reads).toHaveLength(0);
  });

  it('refuses an unauthenticated read', async () => {
    const harness = buildHarness({ scopes: ['payments:read'], snapshot: SNAPSHOT });

    const response = await get(harness, { paymentId: SNAPSHOT.publicId });

    expect(response.statusCode).toBe(401);
  });
});

describe('choosing a network', () => {
  const CRYPTO_BODY = {
    amount: 1_500_000,
    currency: 'USDC',
    paymentMethod: 'crypto',
    reference: 'order-1',
    description: 'A digital thing',
  };

  it('forwards a network the provider declared', async () => {
    const provider = cryptoProviderReturning(GOOD_CRYPTO_INSTRUMENT);
    const harness = buildHarness({ cryptoProvider: provider });

    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: { ...CRYPTO_BODY, network: 'polygon' },
    });

    expect(response.statusCode).toBe(201);
    expect(provider.requests[0]).toMatchObject({ network: 'polygon' });
  });

  it('refuses a network nobody declared, naming it', async () => {
    const harness = buildHarness({
      cryptoProvider: cryptoProviderReturning(GOOD_CRYPTO_INSTRUMENT),
    });

    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: { ...CRYPTO_BODY, network: 'solana' },
    });

    expect(response.statusCode).toBe(422);
    expect(paymentOf(response).failureCode).toBe('no_provider_available');
    expect(paymentOf(response).failureReason).toContain('on solana');
  });

  it('refuses a network that could not be one at the edge', async () => {
    const harness = buildHarness({
      cryptoProvider: cryptoProviderReturning(GOOD_CRYPTO_INSTRUMENT),
    });

    const response = await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: { ...CRYPTO_BODY, network: 'Polygon Mainnet' },
    });

    expect(response.statusCode).toBe(422);
    expect(errorOf(response).param).toBe('network');
  });
});

const getOptions = (harness: Harness, key?: string) =>
  harness.server.inject({
    method: 'GET',
    url: '/v1/payment-options',
    headers: { ...(key !== undefined && { authorization: `Bearer ${key}` }) },
  });

describe('payment options', () => {
  it('requires an authenticated key with the read scope', async () => {
    const harness = buildHarness({ scopes: ['payments:write'] });
    const anonymous = await getOptions(harness);
    const wrongScope = await getOptions(harness, harness.plaintextKey);
    expect(anonymous.statusCode).toBe(401);
    expect(wrongScope.statusCode).toBe(403);
  });

  it('answers what the registry can serve for the key environment', async () => {
    const harness = buildHarness({
      scopes: ['payments:read'],
      cryptoProvider: cryptoProviderReturning(GOOD_CRYPTO_INSTRUMENT),
    });

    const response = await getOptions(harness, harness.plaintextKey);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      environment: 'SANDBOX',
      methods: [
        {
          method: 'crypto',
          providers: [
            {
              code: 'test-crypto',
              displayName: 'Test Crypto',
              currencies: ['USDC'],
              networks: ['polygon'],
            },
          ],
        },
        {
          method: 'pix',
          providers: [
            {
              code: 'test-provider',
              displayName: 'Test Provider',
              currencies: ['BRL'],
              networks: [],
            },
          ],
        },
      ],
    });
  });
});
