import { describe, expect, it } from 'vitest';
import { CryptoPayProvider, cryptoPayDescriptor } from './cryptopay-provider.js';
import type { CryptoPayTransport, TransportResponse } from './cryptopay-provider.js';

const DESCRIPTOR = cryptoPayDescriptor({ network: 'polygon', currencies: ['USDC'] });
const CALLBACK_URL = 'http://payment-gateway:3000/v1/webhooks/cryptopay';

function paymentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
    externalReference: 'payment_01hzx',
    status: 'CREATED',
    network: 'polygon',
    chainId: 31_337,
    currency: 'USDC',
    amount: '25.000000',
    amountReceived: '0.000000',
    paymentDestination: { address: '0x1077840bd639dbd769cb7dde82235d265e73f28a', memo: null },
    paymentUri: 'ethereum:0x5fbd@31337/transfer?address=0x1077&uint256=25000000',
    qrCode: 'data:image/png;base64,AAAA',
    failureReason: null,
    explorer: { address: null, transaction: null },
    transactions: [],
    metadata: {},
    createdAt: '2026-09-11T00:00:00.000Z',
    expiresAt: '2026-09-11T00:30:00.000Z',
    paidAt: null,
    ...overrides,
  };
}

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
}

function transportAnswering(response: TransportResponse): {
  transport: CryptoPayTransport;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  return {
    sent,
    transport: {
      request: (options) => {
        sent.push({
          method: options.method,
          path: options.path,
          idempotencyKey: options.idempotencyKey,
          body: options.body,
        });
        return Promise.resolve(response);
      },
    },
  };
}

function providerOver(transport: CryptoPayTransport): CryptoPayProvider {
  return new CryptoPayProvider(DESCRIPTOR, 'polygon', CALLBACK_URL, transport);
}

const REQUEST = {
  amountMinor: 25_000_000n,
  currency: 'USDC',
  description: 'A digital thing',
  paymentId: 'payment_01hzx',
  merchantReference: 'order-1',
  network: undefined,
  idempotencyKey: 'key-1',
};

describe('creating a crypto instrument', () => {
  it('asks in the gateway contract vocabulary and returns the destination', async () => {
    const { transport, sent } = transportAnswering({
      transport: { kind: 'response', httpStatus: 201 },
      body: paymentBody(),
    });

    const result = await providerOver(transport).createCryptoInstrument(REQUEST);

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') {
      return;
    }
    expect(result.providerReference).toBe('pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N');
    expect(result.value).toEqual({
      network: 'polygon',
      asset: 'USDC',
      destinationAddress: '0x1077840bd639dbd769cb7dde82235d265e73f28a',
      paymentUri: 'ethereum:0x5fbd@31337/transfer?address=0x1077&uint256=25000000',
      qrCodeImageDataUri: 'data:image/png;base64,AAAA',
      amountMinor: 25_000_000n,
      expiresAt: new Date('2026-09-11T00:30:00.000Z'),
    });

    // The request carries our claim key, our payment id as the correlation, a
    // decimal string amount and the callback where signed notifications go.
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.path).toBe('/api/v1/payments');
    expect(sent[0]?.idempotencyKey).toBe('key-1');
    expect(sent[0]?.body).toEqual({
      externalReference: 'payment_01hzx',
      network: 'polygon',
      currency: 'USDC',
      amount: '25.000000',
      callbackUrl: CALLBACK_URL,
      metadata: { merchantReference: 'order-1', description: 'A digital thing' },
    });
  });

  it('declares the network it was registered for and issues on it by default', async () => {
    expect(DESCRIPTOR.supportedNetworks).toEqual(['polygon']);
    const { transport, sent } = transportAnswering({
      transport: { kind: 'response', httpStatus: 201 },
      body: paymentBody(),
    });

    await providerOver(transport).createCryptoInstrument({ ...REQUEST, network: 'polygon' });

    expect(sent[0]?.body).toMatchObject({ network: 'polygon' });
  });

  it('refuses a currency the gateway cannot express before calling anyone', async () => {
    const { transport, sent } = transportAnswering({
      transport: { kind: 'response', httpStatus: 201 },
      body: paymentBody(),
    });

    const result = await providerOver(transport).createCryptoInstrument({
      ...REQUEST,
      currency: 'DOGE',
    });

    expect(result.outcome).toBe('safe_failure');
    expect(sent).toHaveLength(0);
  });

  it('treats a payment created in another currency as uncertain, with its reference', async () => {
    const { transport } = transportAnswering({
      transport: { kind: 'response', httpStatus: 201 },
      body: paymentBody({ currency: 'USDT' }),
    });

    const result = await providerOver(transport).createCryptoInstrument(REQUEST);

    expect(result.outcome).toBe('unknown_outcome');
    expect(result.providerReference).toBe('pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N');
  });

  it('treats a payment with nothing to present as uncertain rather than failed', async () => {
    const { transport } = transportAnswering({
      transport: { kind: 'response', httpStatus: 201 },
      body: paymentBody({ paymentUri: null, qrCode: null }),
    });

    const result = await providerOver(transport).createCryptoInstrument(REQUEST);

    expect(result.outcome).toBe('unknown_outcome');
    expect(result.providerReference).toBe('pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N');
  });

  it.each([
    [422, 'VALIDATION_FAILED', 'safe_failure'],
    [503, 'NETWORK_UNAVAILABLE', 'safe_failure'],
    [429, 'IDEMPOTENCY_KEY_IN_USE', 'unknown_outcome'],
    [422, 'DUPLICATE_EXTERNAL_REFERENCE', 'unknown_outcome'],
    [401, 'UNAUTHENTICATED', 'definitive_failure'],
    [500, undefined, 'unknown_outcome'],
  ] as const)('classifies a %s %s answer as %s', async (httpStatus, code, expected) => {
    const { transport } = transportAnswering({
      transport: { kind: 'response', httpStatus },
      body: code === undefined ? undefined : { error: { code, message: 'x', requestId: 'r' } },
    });

    const result = await providerOver(transport).createCryptoInstrument(REQUEST);

    expect(result.outcome).toBe(expected);
    expect(result.outcome !== 'success' && result.reason).toContain(code ?? 'CryptoPay');
  });

  it('reads a timeout as unknown and a refused connection as retryable', async () => {
    const timedOut = transportAnswering({ transport: { kind: 'timeout' }, body: undefined });
    const refused = transportAnswering({
      transport: { kind: 'connection_error', requestDefinitelyNotDelivered: true },
      body: undefined,
    });

    const afterTimeout = await providerOver(timedOut.transport).createCryptoInstrument(REQUEST);
    const afterRefusal = await providerOver(refused.transport).createCryptoInstrument(REQUEST);

    expect(afterTimeout.outcome).toBe('unknown_outcome');
    expect(afterRefusal.outcome).toBe('retryable_transport_failure');
  });
});

describe('reading crypto payment state', () => {
  it.each([
    ['CREATED', 'awaiting_payment'],
    ['WAITING_FOR_PAYMENT', 'awaiting_payment'],
    ['PAYMENT_DETECTED', 'awaiting_payment'],
    ['CONFIRMING', 'awaiting_payment'],
    ['EXPIRED', 'expired'],
    ['CANCELLED', 'failed'],
    ['FAILED', 'failed'],
    ['SOMETHING_NEW', 'unknown'],
  ] as const)('maps %s to %s without any capture', async (status, lifecycle) => {
    const { transport, sent } = transportAnswering({
      transport: { kind: 'response', httpStatus: 200 },
      body: paymentBody({ status }),
    });

    const result = await providerOver(transport).readPaymentState('pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N');

    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.path).toBe('/api/v1/payments/pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N');
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') {
      return;
    }
    expect(result.value.lifecycle).toBe(lifecycle);
    expect(result.value.capturedAmountMinor).toBe(0n);
    expect(result.value.paidAt).toBeUndefined();
    expect(result.value.rawStatus).toBe(status);
  });

  it('reports a paid payment with what actually arrived, not what was asked', async () => {
    const { transport } = transportAnswering({
      transport: { kind: 'response', httpStatus: 200 },
      body: paymentBody({
        status: 'PAID',
        amountReceived: '25.500000',
        paidAt: '2026-09-11T00:10:00.000Z',
      }),
    });

    const result = await providerOver(transport).readPaymentState('pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N');

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') {
      return;
    }
    expect(result.value.lifecycle).toBe('paid');
    expect(result.value.capturedAmountMinor).toBe(25_500_000n);
    expect(result.value.paidAt).toEqual(new Date('2026-09-11T00:10:00.000Z'));
  });

  it('keeps the failure reason in the raw status for the audit trail', async () => {
    const { transport } = transportAnswering({
      transport: { kind: 'response', httpStatus: 200 },
      body: paymentBody({ status: 'FAILED', failureReason: 'insufficient_amount' }),
    });

    const result = await providerOver(transport).readPaymentState('pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N');

    expect(result.outcome === 'success' && result.value.rawStatus).toBe(
      'FAILED:insufficient_amount',
    );
  });

  it('reports a missing payment as definitive rather than as a lifecycle', async () => {
    const { transport } = transportAnswering({
      transport: { kind: 'response', httpStatus: 404 },
      body: { error: { code: 'PAYMENT_NOT_FOUND', message: 'No such payment.', requestId: 'r' } },
    });

    const result = await providerOver(transport).readPaymentState('pay_missing');

    expect(result.outcome).toBe('definitive_failure');
  });

  it('never invents a lifecycle from a body it cannot read', async () => {
    const { transport } = transportAnswering({
      transport: { kind: 'response', httpStatus: 200 },
      body: { id: 'pay_x', status: 'PAID' },
    });

    const result = await providerOver(transport).readPaymentState('pay_x');

    expect(result.outcome).toBe('unknown_outcome');
  });
});
