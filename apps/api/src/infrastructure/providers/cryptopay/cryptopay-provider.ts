import { isSupportedCurrency } from '@gateway/shared';
import type {
  CreateCryptoInstrumentRequest,
  CryptoInstrument,
  CryptoPaymentProvider,
  ObservedLifecycle,
  ObservedPaymentState,
  ProviderResult,
} from '../../../application/ports/payment-provider.js';
import type { ProviderDescriptor } from '../../../domain/provider/provider-capability.js';
import { classifyTransportResult } from '../../../domain/provider/provider-outcome.js';
import type {
  ProviderOutcomeClass,
  TransportResult,
} from '../../../domain/provider/provider-outcome.js';
import { formatDecimalAmount, parseDecimalAmount } from './cryptopay-amounts.js';

/**
 * The CryptoPay adapter.
 *
 * Everything about CryptoPay stops here. Above this file the gateway speaks of
 * instruments, observed lifecycles and outcome classes; below it there are chain
 * families, decimal strings and an uppercase lifecycle with eight states.
 *
 * CryptoPay's gateway contract at `/api/v1` was designed for exactly this seat:
 * it takes a family rather than a chain, a currency rather than a contract, and
 * returns a payment URI and a QR code already correct for whatever chain it
 * chose. Nothing here knows what a chain id is.
 */

export const CRYPTOPAY_PROVIDER_CODE = 'cryptopay';

export interface CryptoPayDescriptorOptions {
  /**
   * The chain family every payment is created on. The deployment behind the
   * family follows from the API key's environment, so a sandbox key cannot name
   * a live chain whatever this says.
   */
  readonly network: string;
  readonly currencies: readonly string[];
}

export function cryptoPayDescriptor(options: CryptoPayDescriptorOptions): ProviderDescriptor {
  return {
    code: CRYPTOPAY_PROVIDER_CODE,
    displayName: `CryptoPay (${options.network})`,
    capabilities: ['crypto.create', 'crypto.status', 'webhook.receive'],
    supportedCurrencies: options.currencies,
    supportedNetworks: [options.network],
    // Creation carries an Idempotency-Key that CryptoPay honours byte for byte,
    // so a retried request after a timeout is answered with the same payment.
    instrumentCreationIsIdempotent: true,
  };
}

export interface TransportResponse {
  readonly transport: TransportResult;
  readonly body: unknown;
}

/**
 * The seam that keeps this class testable without a network. An implementation
 * never throws for an HTTP status or a timeout; it reports what happened and
 * lets the outcome taxonomy decide.
 */
export interface CryptoPayTransport {
  request(options: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly idempotencyKey?: string;
    readonly body?: unknown;
  }): Promise<TransportResponse>;
}

const PAYMENTS_PATH = '/api/v1/payments';

/**
 * CryptoPay's public lifecycle, mapped into the gateway's closed vocabulary.
 *
 * Every waiting state collapses to `awaiting_payment`, because from here the only
 * question is whether the money is final. CANCELLED is `failed` rather than a
 * state of its own: the instrument can no longer be paid, which is what failed
 * means to the transition table. Anything unlisted is `unknown`, never guessed.
 */
const LIFECYCLES: Readonly<Record<string, ObservedLifecycle>> = {
  CREATED: 'awaiting_payment',
  WAITING_FOR_PAYMENT: 'awaiting_payment',
  PAYMENT_DETECTED: 'awaiting_payment',
  CONFIRMING: 'awaiting_payment',
  PAID: 'paid',
  EXPIRED: 'expired',
  CANCELLED: 'failed',
  FAILED: 'failed',
};

/**
 * Error codes whose meaning the contract states precisely enough to override the
 * HTTP-status default. Everything else falls through to the status taxonomy.
 */
const OUTCOME_BY_ERROR_CODE: Readonly<Record<string, ProviderOutcomeClass>> = {
  // Refused before anything was created: no scanner watches the network yet.
  NETWORK_UNAVAILABLE: 'safe_failure',
  // The same key is mid-flight elsewhere, so a payment may already exist for it.
  IDEMPOTENCY_KEY_IN_USE: 'unknown_outcome',
  // CryptoPay already holds a payment for this reference, which can only be one
  // an earlier attempt created without our recording it.
  DUPLICATE_EXTERNAL_REFERENCE: 'unknown_outcome',
};

interface GatewayPaymentBody {
  readonly id: string;
  readonly status: string;
  readonly network: string;
  readonly currency: string;
  readonly amount: string;
  readonly amountReceived: string;
  readonly paymentDestination: { readonly address: string };
  readonly paymentUri: string | null;
  readonly qrCode: string | null;
  readonly failureReason: string | null;
  readonly expiresAt: string;
  readonly paidAt: string | null;
}

function readPaymentBody(body: unknown): GatewayPaymentBody | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const candidate = body as Record<string, unknown>;
  const destination = candidate.paymentDestination as Record<string, unknown> | undefined;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.status !== 'string' ||
    typeof candidate.network !== 'string' ||
    typeof candidate.currency !== 'string' ||
    typeof candidate.amount !== 'string' ||
    typeof candidate.amountReceived !== 'string' ||
    typeof candidate.expiresAt !== 'string' ||
    typeof destination?.address !== 'string'
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    status: candidate.status,
    network: candidate.network,
    currency: candidate.currency,
    amount: candidate.amount,
    amountReceived: candidate.amountReceived,
    paymentDestination: { address: destination.address },
    paymentUri: typeof candidate.paymentUri === 'string' ? candidate.paymentUri : null,
    qrCode: typeof candidate.qrCode === 'string' ? candidate.qrCode : null,
    failureReason: typeof candidate.failureReason === 'string' ? candidate.failureReason : null,
    expiresAt: candidate.expiresAt,
    paidAt: typeof candidate.paidAt === 'string' ? candidate.paidAt : null,
  };
}

function errorCodeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const error = (body as { error?: { code?: unknown } }).error;
  return typeof error?.code === 'string' ? error.code : undefined;
}

function failureFrom(response: TransportResponse, reason: string): ProviderResult<never> {
  const code = errorCodeOf(response.body);
  const overridden = code === undefined ? undefined : OUTCOME_BY_ERROR_CODE[code];
  const classified = overridden ?? classifyTransportResult(response.transport);
  // A transport that succeeded with a body nobody can read is not a success; it
  // is precisely the ambiguity the taxonomy reserves unknown_outcome for.
  const outcome = classified === 'success' ? 'unknown_outcome' : classified;
  return {
    outcome,
    reason: code === undefined ? reason : `${reason} (${code})`,
  };
}

function parseTimestamp(value: string | null): Date | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export class CryptoPayProvider implements CryptoPaymentProvider {
  public constructor(
    public readonly descriptor: ProviderDescriptor,
    private readonly network: string,
    private readonly callbackUrl: string,
    private readonly transport: CryptoPayTransport,
  ) {}

  public async createCryptoInstrument(
    request: CreateCryptoInstrumentRequest,
  ): Promise<ProviderResult<CryptoInstrument>> {
    if (!isSupportedCurrency(request.currency)) {
      return {
        outcome: 'safe_failure',
        reason: `${request.currency} is not a currency this gateway can express in minor units.`,
      };
    }
    const currency = request.currency;

    const response = await this.transport.request({
      method: 'POST',
      path: PAYMENTS_PATH,
      idempotencyKey: request.idempotencyKey,
      body: {
        externalReference: request.paymentId,
        network: request.network ?? this.network,
        currency,
        amount: formatDecimalAmount(request.amountMinor, currency),
        callbackUrl: this.callbackUrl,
        metadata: {
          merchantReference: request.merchantReference,
          description: request.description,
        },
      },
    });

    if (classifyTransportResult(response.transport) !== 'success') {
      return failureFrom(response, 'CryptoPay did not create the payment.');
    }

    const body = readPaymentBody(response.body);
    if (body === undefined) {
      return failureFrom(response, 'CryptoPay answered with a payment nobody here can read.');
    }
    if (body.paymentUri === null || body.qrCode === null) {
      return {
        outcome: 'unknown_outcome',
        reason: 'CryptoPay created a payment without a payment URI or QR code to present.',
        providerReference: body.id,
      };
    }
    if (body.currency !== currency) {
      return {
        outcome: 'unknown_outcome',
        reason: `CryptoPay created a payment in ${body.currency}, not the ${currency} requested.`,
        providerReference: body.id,
      };
    }

    let amountMinor: bigint;
    try {
      amountMinor = parseDecimalAmount(body.amount, currency);
    } catch (error) {
      return {
        outcome: 'unknown_outcome',
        reason: error instanceof Error ? error.message : 'CryptoPay reported an unreadable amount.',
        providerReference: body.id,
      };
    }

    return {
      outcome: 'success',
      providerReference: body.id,
      value: {
        network: body.network,
        asset: body.currency,
        destinationAddress: body.paymentDestination.address,
        paymentUri: body.paymentUri,
        qrCodeImageDataUri: body.qrCode,
        amountMinor,
        expiresAt: parseTimestamp(body.expiresAt),
      },
    };
  }

  /**
   * The authenticated read. This is the only thing permitted to fund a payment:
   * the webhook that prompted it carried the same resource, and is trusted for
   * nothing beyond bringing this call forward.
   */
  public async readPaymentState(
    providerReference: string,
  ): Promise<ProviderResult<ObservedPaymentState>> {
    const response = await this.transport.request({
      method: 'GET',
      path: `${PAYMENTS_PATH}/${encodeURIComponent(providerReference)}`,
    });

    if (classifyTransportResult(response.transport) !== 'success') {
      return failureFrom(response, 'CryptoPay did not answer about the payment.');
    }

    const body = readPaymentBody(response.body);
    if (body === undefined) {
      return failureFrom(response, 'CryptoPay answered with a payment nobody here can read.');
    }
    if (!isSupportedCurrency(body.currency)) {
      return {
        outcome: 'unknown_outcome',
        reason: `CryptoPay reports the payment in ${body.currency}, which this gateway cannot express.`,
        providerReference: body.id,
      };
    }

    const lifecycle = LIFECYCLES[body.status] ?? 'unknown';
    const rawStatus =
      body.failureReason === null ? body.status : `${body.status}:${body.failureReason}`;

    let capturedAmountMinor: bigint;
    try {
      // What actually arrived, never what was asked for. An overpayment is
      // reported as the larger number and it is the gateway's rule, not this
      // adapter's, that decides whether a disagreeing amount may fund a payment.
      capturedAmountMinor =
        lifecycle === 'paid' ? parseDecimalAmount(body.amountReceived, body.currency) : 0n;
    } catch (error) {
      return {
        outcome: 'unknown_outcome',
        reason: error instanceof Error ? error.message : 'CryptoPay reported an unreadable amount.',
        providerReference: body.id,
      };
    }

    return {
      outcome: 'success',
      providerReference: body.id,
      value: {
        lifecycle,
        capturedAmountMinor,
        paidAt: lifecycle === 'paid' ? parseTimestamp(body.paidAt) : undefined,
        rawStatus,
      },
    };
  }
}
