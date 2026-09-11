/**
 * The gateway's public surface, as the checkout uses it: what can be served,
 * create a payment, read it back, and what is reachable behind the gateway.
 *
 * This is the only network client on the page. CryptoPay, the chain and the
 * notification platform are seen exclusively through what the gateway records.
 */

export interface PaymentOptions {
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly methods: readonly {
    readonly method: string;
    readonly providers: readonly {
      readonly code: string;
      readonly displayName: string;
      readonly currencies: readonly string[];
      readonly networks: readonly string[];
    }[];
  }[];
}

interface CryptoInstrument {
  readonly type: 'crypto';
  readonly network: string;
  readonly asset: string;
  readonly destinationAddress: string;
  readonly paymentUri: string;
  readonly qrCodeImageDataUri: string;
  readonly expiresAt?: string;
}

interface PixInstrument {
  readonly type: 'pix';
  readonly copyAndPasteCode: string;
  readonly qrCodeImageDataUri?: string;
  readonly expiresAt?: string;
}

interface Transition {
  readonly sequence: number;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly trigger: string;
  readonly evidenceClass: string;
  readonly reason?: string;
  readonly occurredAt: string;
}

interface ProviderNotification {
  readonly provider: string;
  readonly eventType: string;
  readonly receivedAt: string;
  readonly disposition: string;
}

interface PaymentEvent {
  readonly type: string;
  readonly occurredAt: string;
  readonly delivery: {
    readonly channel: string;
    readonly status: string;
    readonly attempts: number;
    readonly reference?: string;
    readonly publishedAt?: string;
    readonly lastFailure?: string;
  };
}

export interface PaymentDetail {
  readonly id: string;
  readonly status: string;
  readonly paymentMethod: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly amountMinor: string;
  readonly capturedAmountMinor: string;
  readonly currency: string;
  readonly merchantReference: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly paidAt?: string;
  readonly provider?: string;
  readonly providerReference?: string;
  readonly instrument?: CryptoInstrument | PixInstrument;
  readonly transitions: readonly Transition[];
  readonly providerNotifications: readonly ProviderNotification[];
  readonly events: readonly PaymentEvent[];
}

export interface CreatedPayment {
  readonly id: string;
  readonly status: string;
  readonly failureCode?: string;
  readonly failureReason?: string;
}

export type IntegrationStatus = 'up' | 'down' | 'not_configured';

export interface Readiness {
  readonly status: string;
  readonly checks: {
    readonly database: { readonly status: string };
    readonly integrations?: Readonly<Record<string, { readonly status: IntegrationStatus }>>;
  };
}

export interface Connection {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface GatewayFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly param?: string;
}

export type GatewayResult<Body> =
  | { readonly ok: true; readonly body: Body }
  | { readonly ok: false; readonly failure: GatewayFailure };

export type CreatePaymentRequest =
  | {
      readonly paymentMethod: 'crypto';
      readonly amount: number;
      readonly currency: string;
      readonly network: string;
      readonly reference: string;
      readonly description: string;
      readonly customer?: { readonly phone: string };
    }
  | {
      readonly paymentMethod: 'pix';
      readonly amount: number;
      readonly currency: 'BRL';
      readonly reference: string;
      readonly description: string;
      readonly customer: {
        readonly firstName: string;
        readonly lastName: string;
        readonly email: string;
        readonly phone: string;
        readonly documentNumber: string;
      };
    };

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

async function parseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function failureOf(status: number, body: unknown): GatewayFailure {
  const error =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error?: Record<string, unknown> }).error
      : undefined;
  const code = typeof error?.code === 'string' ? error.code : 'unexpected_response';
  const message =
    typeof error?.message === 'string'
      ? error.message
      : `The gateway answered ${String(status)} without a documented error.`;
  return {
    status,
    code,
    message,
    ...(typeof error?.param === 'string' && { param: error.param }),
  };
}

async function call<Body>(
  connection: Connection,
  path: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly body?: unknown;
    readonly idempotencyKey?: string;
  },
): Promise<GatewayResult<Body>> {
  let response: Response;
  try {
    response = await fetch(`${trimSlash(connection.baseUrl)}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${connection.apiKey}`,
        'content-type': 'application/json',
        ...(init.idempotencyKey !== undefined && { 'idempotency-key': init.idempotencyKey }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
  } catch {
    return {
      ok: false,
      failure: {
        status: 0,
        code: 'unreachable',
        message: 'The gateway could not be reached from this page.',
      },
    };
  }
  const body = await parseBody(response);
  if (!response.ok) {
    return { ok: false, failure: failureOf(response.status, body) };
  }
  return { ok: true, body: body as Body };
}

export const readPaymentOptions = (
  connection: Connection,
): Promise<GatewayResult<PaymentOptions>> =>
  call(connection, '/v1/payment-options', { method: 'GET' });

export const createPayment = (
  connection: Connection,
  request: CreatePaymentRequest,
  idempotencyKey: string,
): Promise<GatewayResult<CreatedPayment>> =>
  call(connection, '/v1/payments', { method: 'POST', body: request, idempotencyKey });

export const readPayment = (
  connection: Connection,
  paymentId: string,
): Promise<GatewayResult<PaymentDetail>> =>
  call(connection, `/v1/payments/${encodeURIComponent(paymentId)}`, { method: 'GET' });

/**
 * Readiness needs no key, so it is the one thing asked before one is known. A
 * gateway that is not there answers undefined rather than throwing.
 */
export async function readReadiness(baseUrl: string): Promise<Readiness | undefined> {
  try {
    const response = await fetch(`${trimSlash(baseUrl)}/ready`);
    return (await response.json()) as Readiness;
  } catch {
    return undefined;
  }
}
