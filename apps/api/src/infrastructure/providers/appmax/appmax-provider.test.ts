import { Secret } from '@gateway/shared/server';
import { describe, expect, it } from 'vitest';
import type { CreatePixInstrumentRequest } from '../../../application/ports/payment-provider.js';
import { assertCapabilitiesAreImplemented } from '../../../domain/provider/provider-capability.js';
import type { ProviderCapability } from '../../../domain/provider/provider-capability.js';
import { APPMAX_DESCRIPTOR, AppmaxPixProvider } from './appmax-provider.js';
import type { AppmaxTransport, TransportResponse } from './appmax-provider.js';
import { AppmaxTokenCache } from './appmax-token-cache.js';

const PIX_CODE = '00020126360014BR.GOV.BCB.PIX0114+55619999999996304ABCD';

const REQUEST: CreatePixInstrumentRequest = {
  amountMinor: 12_300n,
  currency: 'BRL',
  description: 'Order 1',
  reference: 'order-1',
  customer: {
    firstName: 'Junior',
    lastName: 'Almeida',
    email: 'junior@example.com',
    phone: '51983655100',
    documentNumber: '25226493029',
    ipAddress: '127.0.0.1',
  },
};

function ok(body: unknown, httpStatus = 200): TransportResponse {
  return { transport: { kind: 'response', httpStatus }, body };
}

/**
 * Records what was sent so the wire contract can be asserted, not assumed.
 */
function transportReturning(...responses: TransportResponse[]): AppmaxTransport & {
  readonly sent: { method: string; path: string; body?: unknown }[];
} {
  const sent: { method: string; path: string; body?: unknown }[] = [];
  let index = 0;

  return {
    sent,
    request: (options) => {
      sent.push({ method: options.method, path: options.path, body: options.body });
      const response = responses[index] ?? responses.at(-1);
      index += 1;
      return Promise.resolve(response ?? ok({}));
    },
  };
}

function providerWith(transport: AppmaxTransport): AppmaxPixProvider {
  const tokens = new AppmaxTokenCache(() =>
    Promise.resolve({ accessToken: new Secret('token'), expiresInSeconds: 3600 }),
  );
  return new AppmaxPixProvider(transport, tokens);
}

const CUSTOMER_CREATED = ok({ data: { customer: { id: 2023 } } });
const ORDER_CREATED = ok({ data: { order: { id: 3531, status: 'pendente' } } });
const PIX_ISSUED = ok({ data: { pix: { emv_code: PIX_CODE, expires_at: '2026-09-09 15:30:00' } } });

function countingTokens() {
  let issued = 0;
  return {
    get issuedCount() {
      return issued;
    },
    cache: new AppmaxTokenCache(() => {
      issued += 1;
      return Promise.resolve({
        accessToken: new Secret(`token-${issued}`),
        expiresInSeconds: 3600,
      });
    }),
  };
}

describe('the descriptor', () => {
  it('implements everything it declares', () => {
    expect(() =>
      assertCapabilitiesAreImplemented(
        APPMAX_DESCRIPTOR,
        new Set<ProviderCapability>(APPMAX_DESCRIPTOR.capabilities),
      ),
    ).not.toThrow();
  });

  it('declares no card or boleto capability, rather than pretending', () => {
    expect(APPMAX_DESCRIPTOR.capabilities).not.toContain('card.create');
    expect(APPMAX_DESCRIPTOR.capabilities).not.toContain('boleto.create');
  });

  it('records that instrument creation cannot be safely repeated', () => {
    expect(APPMAX_DESCRIPTOR.instrumentCreationIsIdempotent).toBe(false);
  });
});

describe('creating a Pix instrument', () => {
  it('follows the customer, order, payment sequence Appmax requires', async () => {
    const transport = transportReturning(CUSTOMER_CREATED, ORDER_CREATED, PIX_ISSUED);
    const result = await providerWith(transport).createPixInstrument(REQUEST);

    expect(transport.sent.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /v1/customers',
      'POST /v1/orders',
      'POST /v1/payments/pix',
    ]);

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') {
      throw new Error('expected the instrument to be created');
    }
    expect(result.value.copyAndPasteCode).toBe(PIX_CODE);
    expect(result.providerReference).toBe('3531');
  });

  it('sends the amount as integer cents, so nothing is ever rounded', async () => {
    const transport = transportReturning(CUSTOMER_CREATED, ORDER_CREATED, PIX_ISSUED);
    await providerWith(transport).createPixInstrument(REQUEST);

    const order = transport.sent[1]?.body as {
      products_value: number;
      products: { unit_value: number }[];
    };
    expect(order.products_value).toBe(12_300);
    expect(order.products[0]?.unit_value).toBe(12_300);
  });

  it('reports an unknown outcome when the order call times out', async () => {
    // Not a failure. Appmax may have created the order, and there is no way to
    // search for it, so retrying or failing over could produce a second one.
    const transport = transportReturning(CUSTOMER_CREATED, {
      transport: { kind: 'timeout' },
      body: undefined,
    });
    const result = await providerWith(transport).createPixInstrument(REQUEST);

    expect(result.outcome).toBe('unknown_outcome');
  });

  it('carries the order reference when the Pix response is unreadable', async () => {
    // The order exists and may already be payable. An ambiguous outcome that can
    // be reconciled is far cheaper than one that cannot.
    const transport = transportReturning(CUSTOMER_CREATED, ORDER_CREATED, ok({ data: {} }));
    const result = await providerWith(transport).createPixInstrument(REQUEST);

    expect(result.outcome).toBe('unknown_outcome');
    if (result.outcome === 'success') {
      throw new Error('expected a failure');
    }
    expect(result.providerReference).toBe('3531');
  });

  it('treats a rejected request as a safe failure, so another provider may be tried', async () => {
    const transport = transportReturning({
      transport: { kind: 'response', httpStatus: 422 },
      body: { errors: { customer: 'invalid' } },
    });
    const result = await providerWith(transport).createPixInstrument(REQUEST);

    expect(result.outcome).toBe('safe_failure');
  });

  it('treats a provider server error as unknown rather than safe', async () => {
    const transport = transportReturning(CUSTOMER_CREATED, {
      transport: { kind: 'response', httpStatus: 500 },
      body: {},
    });
    const result = await providerWith(transport).createPixInstrument(REQUEST);

    expect(result.outcome).toBe('unknown_outcome');
  });

  it('stops before creating an order when no customer comes back', async () => {
    const transport = transportReturning(ok({ data: {} }));
    const result = await providerWith(transport).createPixInstrument(REQUEST);

    expect(result.outcome).not.toBe('success');
    expect(transport.sent).toHaveLength(1);
  });
});

describe('reading payment state', () => {
  it('translates an approved order into a funded observation', async () => {
    const transport = transportReturning(
      ok({
        data: {
          order: { id: 3531, status: 'aprovado', total_paid: 12_300 },
          payment: { paid_at: '2026-09-09 14:30:00' },
        },
      }),
    );

    const result = await providerWith(transport).readPaymentState('3531');

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') {
      throw new Error('expected a reading');
    }
    expect(result.value.lifecycle).toBe('paid');
    expect(result.value.capturedAmountMinor).toBe(12_300n);
    expect(result.value.paidAt?.toISOString()).toBe('2026-09-09T17:30:00.000Z');
    expect(result.value.rawStatus).toBe('aprovado');
  });

  it('translates a cancelled order into expired with nothing captured', async () => {
    const transport = transportReturning(ok({ data: { order: { status: 'cancelado' } } }));
    const result = await providerWith(transport).readPaymentState('3531');

    expect(result.outcome === 'success' && result.value.lifecycle).toBe('expired');
    expect(result.outcome === 'success' && result.value.capturedAmountMinor).toBe(0n);
  });

  it('refuses to guess at a status it does not recognise', async () => {
    // A status Appmax adds later must surface, not settle silently into something
    // convenient. This is the exact failure the legacy system had.
    const transport = transportReturning(ok({ data: { order: { status: 'liquidado' } } }));
    const result = await providerWith(transport).readPaymentState('3531');

    expect(result.outcome).toBe('unknown_outcome');
    if (result.outcome === 'success') {
      throw new Error('expected an unknown outcome');
    }
    expect(result.reason).toContain('liquidado');
  });

  it('escapes the reference it puts in the path', async () => {
    const transport = transportReturning(ok({ data: { order: { status: 'pendente' } } }));
    await providerWith(transport).readPaymentState('3531/../../admin');

    expect(transport.sent[0]?.path).toBe('/v1/orders/3531%2F..%2F..%2Fadmin');
  });
});

describe('refunding', () => {
  it('asks for a total refund and reports the resulting state', async () => {
    const transport = transportReturning(ok({ data: { order: { status: 'estornado' } } }, 201));
    const result = await providerWith(transport).refundInFull('3531');

    expect(transport.sent[0]).toEqual({
      method: 'POST',
      path: '/v1/orders/refund-request',
      body: { order_id: 3531, type: 'total' },
    });
    expect(result.outcome === 'success' && result.value.lifecycle).toBe('refunded');
  });
});

describe('reacting to a rejected token', () => {
  /**
   * A cache that keeps handing out a token Appmax has already rejected would
   * fail every subsequent call until the token expired on its own.
   */
  it('drops the cached token after a 401 so the next call re-authenticates', async () => {
    const tokens = countingTokens();
    const transport = transportReturning({
      transport: { kind: 'response', httpStatus: 401 },
      body: { message: 'Unauthorized' },
    });
    const provider = new AppmaxPixProvider(transport, tokens.cache);

    await provider.readPaymentState('3531');
    expect(tokens.issuedCount).toBe(1);

    await provider.readPaymentState('3531');
    expect(tokens.issuedCount).toBe(2);
  });

  it('keeps the cached token after a 403, which re-authenticating cannot fix', async () => {
    // Refreshing here would spin against a provider that is already refusing us.
    const tokens = countingTokens();
    const transport = transportReturning({
      transport: { kind: 'response', httpStatus: 403 },
      body: {},
    });
    const provider = new AppmaxPixProvider(transport, tokens.cache);

    await provider.readPaymentState('3531');
    await provider.readPaymentState('3531');

    expect(tokens.issuedCount).toBe(1);
  });

  it('keeps the cached token across ordinary successful calls', async () => {
    const tokens = countingTokens();
    const transport = transportReturning(ok({ data: { order: { status: 'pendente' } } }));
    const provider = new AppmaxPixProvider(transport, tokens.cache);

    await provider.readPaymentState('3531');
    await provider.readPaymentState('3531');

    expect(tokens.issuedCount).toBe(1);
  });
});
