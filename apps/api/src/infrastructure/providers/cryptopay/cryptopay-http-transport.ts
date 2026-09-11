import { Agent, request } from 'undici';
import type { Secret } from '@gateway/shared/server';
import type { TransportResult } from '../../../domain/provider/provider-outcome.js';
import type { CryptoPayTransport, TransportResponse } from './cryptopay-provider.js';

/**
 * The real CryptoPay transport.
 *
 * As with Appmax, it never throws for an HTTP status, a timeout or a connection
 * failure. Whether a retry is safe and whether another provider may be tried both
 * depend on telling "CryptoPay said no" apart from "we have no idea whether
 * CryptoPay acted", and an exception collapses the two.
 *
 * The API key is exposed into a header value and nowhere else.
 */

export interface CryptoPayTimeouts {
  readonly connectMilliseconds: number;
  readonly headersMilliseconds: number;
  readonly bodyMilliseconds: number;
}

const DEFAULT_CRYPTOPAY_TIMEOUTS: CryptoPayTimeouts = {
  connectMilliseconds: 5000,
  headersMilliseconds: 15_000,
  bodyMilliseconds: 15_000,
};

export interface TransportLogger {
  debug(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

const JSON_CONTENT_TYPE = 'application/json';

function transportResultFromError(error: unknown): TransportResult {
  const code = (error as { code?: string } | undefined)?.code ?? '';

  if (['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND'].includes(code)) {
    return { kind: 'connection_error', requestDefinitelyNotDelivered: true };
  }
  if (['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) {
    return { kind: 'timeout' };
  }
  return { kind: 'connection_error' };
}

function parseTransport(httpStatus: number, text: string): TransportResult {
  if (text.length === 0) {
    return { kind: 'response', httpStatus };
  }
  try {
    JSON.parse(text);
    return { kind: 'response', httpStatus };
  } catch {
    return { kind: 'malformed_body', httpStatus };
  }
}

function parseBody(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class UndiciCryptoPayTransport implements CryptoPayTransport {
  private readonly agent: Agent;

  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: Secret,
    private readonly logger: TransportLogger,
    timeouts: CryptoPayTimeouts = DEFAULT_CRYPTOPAY_TIMEOUTS,
  ) {
    this.agent = new Agent({
      connectTimeout: timeouts.connectMilliseconds,
      headersTimeout: timeouts.headersMilliseconds,
      bodyTimeout: timeouts.bodyMilliseconds,
    });
  }

  public async request(options: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly idempotencyKey?: string;
    readonly body?: unknown;
  }): Promise<TransportResponse> {
    const startedAt = process.hrtime.bigint();
    const url = `${this.baseUrl}${options.path}`;

    let response: TransportResponse;
    try {
      const raw = await request(url, {
        method: options.method,
        dispatcher: this.agent,
        headers: {
          authorization: `Bearer ${this.apiKey.expose()}`,
          accept: JSON_CONTENT_TYPE,
          ...(options.body !== undefined && { 'content-type': JSON_CONTENT_TYPE }),
          ...(options.idempotencyKey !== undefined && {
            'idempotency-key': options.idempotencyKey,
          }),
        },
        ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      });
      const text = await raw.body.text();
      response = { transport: parseTransport(raw.statusCode, text), body: parseBody(text) };
    } catch (error) {
      response = { transport: transportResultFromError(error), body: undefined };
    }

    this.logger.debug(
      {
        provider: 'cryptopay',
        method: options.method,
        path: options.path,
        httpStatus: response.transport.httpStatus,
        transportKind: response.transport.kind,
        durationMilliseconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      },
      'cryptopay request completed',
    );

    if (response.transport.kind === 'response' && (response.transport.httpStatus ?? 0) >= 400) {
      this.logger.warn(
        {
          provider: 'cryptopay',
          path: options.path,
          httpStatus: response.transport.httpStatus,
          // The error code only. The message is prose CryptoPay may reword, and
          // nothing else in the body is ours to log.
          code: errorCodeOf(response.body),
        },
        'cryptopay rejected a request',
      );
    }

    return response;
  }
}

function errorCodeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const error = (body as { error?: { code?: unknown } }).error;
  return typeof error?.code === 'string' ? error.code : undefined;
}
