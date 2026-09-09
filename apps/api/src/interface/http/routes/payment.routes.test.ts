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
  PixInstrument,
  PixPaymentProvider,
  ProviderResult,
} from '../../../application/ports/payment-provider.js';
import { ProviderRegistry } from '../../../application/provider-registry.js';
import type { ApiKeyScope } from '../../../domain/api-key/api-key.js';
import { payableBrCode } from '../../../domain/pix/br-code.test-support.js';
import type { ProviderDescriptor } from '../../../domain/provider/provider-capability.js';
import type { ApiErrorBody } from '../errors.js';
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
}

function buildHarness(options: {
  scopes?: ApiKeyScope[];
  environment?: 'SANDBOX' | 'PRODUCTION';
  revoked?: boolean;
  providerResult?: ProviderResult<PixInstrument>;
  /**
   * Omitted entirely to test the "no provider is configured" path.
   */
  withoutProvider?: boolean;
  claim?: ClaimResult;
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
  const server = Fastify() as unknown as ApplicationServer;

  const provider = providerReturning(options.providerResult ?? GOOD_INSTRUMENT);
  const providers =
    options.withoutProvider === true
      ? new ProviderRegistry([])
      : new ProviderRegistry([{ descriptor: provider.descriptor, pix: provider, priority: 1 }]);

  registerPaymentRoutes(server, {
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
          return Promise.resolve(options.claim ?? CLAIM_CREATED);
        },
        openAttempt: () => Promise.resolve('attempt-1'),
        applyProviderOutcome: () => Promise.resolve(),
      },
      providers,
    },
  });

  return { server, plaintextKey: generated.plaintext.expose(), received };
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

  it('carries the request id into every error body', async () => {
    const harness = buildHarness({});
    const response = await post(harness, { idempotencyKey: 'key-1' });

    expect(errorOf(response).requestId).toBeTruthy();
    expect(response.headers['x-request-id']).toBeUndefined();
  });
});

describe('the environment comes from the key, never the body', () => {
  it('uses the key environment when creating the payment', async () => {
    const harness = buildHarness({ environment: 'SANDBOX' });
    await post(harness, {
      key: harness.plaintextKey,
      idempotencyKey: 'key-1',
      body: { ...VALID_BODY },
    });

    expect(harness.received[0]).toMatchObject({
      environment: 'SANDBOX',
      organizationId: 'organization-1',
    });
  });
});

describe('the outcome mapping', () => {
  it('answers 201 with the instrument when the provider issues one', async () => {
    const harness = buildHarness({});
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(201);
    const body = paymentOf(response);
    expect(body.status).toBe('awaiting_payment');
    expect(body.instrument?.copyAndPasteCode).toBe(payableBrCode('10.00'));
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
    const harness = buildHarness({ withoutProvider: true });
    const response = await post(harness, { key: harness.plaintextKey, idempotencyKey: 'key-1' });

    expect(response.statusCode).toBe(422);
    expect(errorOf(response).code).toBe('no_provider_available');
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
