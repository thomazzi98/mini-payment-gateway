import type { Secret } from '@gateway/shared/server';
import type {
  CreatePixInstrumentRequest,
  ObservedPaymentState,
  PixInstrument,
  PixPaymentProvider,
  ProviderResult,
  RefundCapableProvider,
} from '../../../application/ports/payment-provider.js';
import type { ProviderDescriptor } from '../../../domain/provider/provider-capability.js';
import { classifyTransportResult } from '../../../domain/provider/provider-outcome.js';
import type { TransportResult } from '../../../domain/provider/provider-outcome.js';
import { classifyAppmaxFailure, requiresTokenRefresh } from './appmax-failure.js';
import { lifecycleForOrderStatus } from './appmax-mappings.js';
import {
  normalizePixResponse,
  parseAppmaxTimestamp,
  readOrderReference,
} from './appmax-pix-response.js';
import type { AppmaxTokenCache } from './appmax-token-cache.js';

/**
 * The Appmax adapter.
 *
 * Everything about Appmax stops here. Above this file the gateway speaks only of
 * instruments, observed lifecycles and outcome classes; below it there are
 * customers, orders and Portuguese status strings.
 *
 * The sequence Appmax requires is customer, then order, then payment. Only the
 * first of those is safely repeatable — it upserts on a natural key — and only if
 * replayed byte for byte. Order creation carries no idempotency key and no
 * external reference, so it is attempted exactly once and never retried.
 */

export const APPMAX_DESCRIPTOR: ProviderDescriptor = {
  code: 'appmax',
  displayName: 'Appmax',
  capabilities: ['pix.create', 'pix.status', 'order.read', 'refund.full', 'webhook.receive'],
  supportedCurrencies: ['BRL'],
  // Order creation has no idempotency key and no merchant reference, so a retry
  // can produce a second order. The routing layer needs this as a fact.
  instrumentCreationIsIdempotent: false,
};

/**
 * A response as the transport saw it, before anything is believed about it.
 */
export interface TransportResponse {
  readonly transport: TransportResult;
  readonly body: unknown;
}

/**
 * The seam that keeps this class testable without a network.
 *
 * An implementation never throws for an HTTP status or a timeout; it reports what
 * happened and lets the outcome taxonomy decide. A thrown exception would collapse
 * "the provider said no" and "we have no idea what happened" into one thing, and
 * those two must never be confused.
 */
export interface AppmaxTransport {
  request(options: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly accessToken: Secret;
    readonly body?: unknown;
  }): Promise<TransportResponse>;
}

function failureFrom(
  response: TransportResponse,
  reason: string,
  providerReference?: string,
): ProviderResult<never> {
  const outcome = classifyTransportResult(response.transport);
  if (outcome === 'success') {
    // The transport succeeded but the body was unusable, which is precisely the
    // ambiguous case: Appmax may well have created something we cannot see.
    return providerReference === undefined
      ? { outcome: 'unknown_outcome', reason }
      : { outcome: 'unknown_outcome', reason, providerReference };
  }
  return providerReference === undefined
    ? { outcome, reason }
    : { outcome, reason, providerReference };
}

export class AppmaxPixProvider implements PixPaymentProvider, RefundCapableProvider {
  public readonly descriptor = APPMAX_DESCRIPTOR;

  public constructor(
    private readonly transport: AppmaxTransport,
    private readonly tokens: AppmaxTokenCache,
  ) {}

  /**
   * Sends a request and, when Appmax reports the token is no longer good, drops
   * the cached one so the next call re-authenticates.
   *
   * Only a 401 does this. A 403 is a permission the credential does not have,
   * and re-authenticating would not fix it — it would just spin against a
   * provider that is already refusing us.
   */
  private async send(options: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly body?: unknown;
  }): Promise<TransportResponse> {
    const accessToken = await this.tokens.currentToken();
    const response = await this.transport.request({
      method: options.method,
      path: options.path,
      accessToken,
      ...(options.body !== undefined && { body: options.body }),
    });

    if (requiresTokenRefresh(classifyAppmaxFailure(response.transport))) {
      this.tokens.invalidate();
    }

    return response;
  }

  private observedStateFrom(
    response: TransportResponse,
    providerReference: string,
  ): ProviderResult<ObservedPaymentState> {
    const order = readOrder(response.body);
    if (order === undefined) {
      return failureFrom(response, 'Appmax returned no order object.', providerReference);
    }

    const rawStatus = typeof order['status'] === 'string' ? order['status'] : '';
    const lifecycle = lifecycleForOrderStatus(rawStatus);

    // A status Appmax has added since this mapping was written must not be guessed
    // at. Reported as unknown so it surfaces rather than silently settling.
    if (lifecycle === 'unknown') {
      return {
        outcome: 'unknown_outcome',
        reason: `Appmax reported an unmapped order status: ${rawStatus}`,
        providerReference,
      };
    }

    return {
      outcome: 'success',
      providerReference,
      value: {
        lifecycle,
        capturedAmountMinor: readCapturedAmount(order),
        paidAt: readPaidAt(response.body),
        rawStatus,
      },
    };
  }

  public async createPixInstrument(
    request: CreatePixInstrumentRequest,
  ): Promise<ProviderResult<PixInstrument>> {
    const customer = await this.send({
      method: 'POST',
      path: '/v1/customers',
      body: {
        first_name: request.customer.firstName,
        last_name: request.customer.lastName,
        email: request.customer.email,
        phone: request.customer.phone,
        document_number: request.customer.documentNumber,
        ip: request.customer.ipAddress,
      },
    });

    const customerId = readCustomerIdentifier(customer.body);
    if (customerId === undefined) {
      return failureFrom(customer, 'Appmax did not return a customer identifier.');
    }

    // Amounts travel as integer cents, which is what Appmax expects and what the
    // gateway holds, so nothing is converted and nothing can be rounded.
    const amountMinor = Number(request.amountMinor);
    const order = await this.send({
      method: 'POST',
      path: '/v1/orders',
      body: {
        customer_id: customerId,
        products_value: amountMinor,
        discount_value: 0,
        shipping_value: 0,
        products: [
          {
            sku: request.reference,
            name: request.description,
            quantity: 1,
            unit_value: amountMinor,
            type: 'digital',
          },
        ],
      },
    });

    const orderReference = readOrderReference(order.body);
    if (orderReference === undefined) {
      // Nothing to correlate on. The order may or may not exist, and Appmax offers
      // no way to search for it, so this is reported as ambiguous rather than as a
      // failure and is never retried.
      return failureFrom(order, 'Appmax did not return an order identifier.');
    }

    const payment = await this.send({
      method: 'POST',
      path: '/v1/payments/pix',
      body: {
        order_id: Number(orderReference),
        payment_data: { pix: { document_number: request.customer.documentNumber } },
      },
    });

    try {
      const normalized = normalizePixResponse(payment.body);
      return {
        outcome: 'success',
        value: normalized.instrument,
        providerReference: orderReference,
      };
    } catch (error) {
      // The order exists and may already be payable, so the reference is carried
      // through: an ambiguous outcome that can be reconciled is far cheaper than
      // one that cannot.
      return failureFrom(
        payment,
        error instanceof Error ? error.message : 'The Pix response was unreadable.',
        orderReference,
      );
    }
  }

  public async readPaymentState(
    providerReference: string,
  ): Promise<ProviderResult<ObservedPaymentState>> {
    const response = await this.send({
      method: 'GET',
      path: `/v1/orders/${encodeURIComponent(providerReference)}`,
    });

    return this.observedStateFrom(response, providerReference);
  }

  public async refundInFull(
    providerReference: string,
  ): Promise<ProviderResult<ObservedPaymentState>> {
    const response = await this.send({
      method: 'POST',
      path: '/v1/orders/refund-request',
      body: { order_id: Number(providerReference), type: 'total' },
    });

    return this.observedStateFrom(response, providerReference);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readCustomerIdentifier(body: unknown): number | undefined {
  const identifier = asRecord(asRecord(asRecord(body)?.['data'])?.['customer'])?.['id'];
  return typeof identifier === 'number' && Number.isSafeInteger(identifier)
    ? identifier
    : undefined;
}

function readOrder(body: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(asRecord(body)?.['data'])?.['order']);
}

function readCapturedAmount(order: Record<string, unknown>): bigint {
  const paid = order['total_paid'];
  if (typeof paid === 'number' && Number.isSafeInteger(paid) && paid >= 0) {
    return BigInt(paid);
  }
  return 0n;
}

function readPaidAt(body: unknown): Date | undefined {
  const payment = asRecord(asRecord(asRecord(body)?.['data'])?.['payment']);
  const paidAt = payment?.['paid_at'];
  return typeof paidAt === 'string' ? parseAppmaxTimestamp(paidAt) : undefined;
}
