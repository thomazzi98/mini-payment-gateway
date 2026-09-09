import { Agent, request } from 'undici';
import { Secret } from '@gateway/shared/server';
import type { Environment } from '../../../domain/api-key/api-key.js';
import type { TransportResult } from '../../../domain/provider/provider-outcome.js';
import type { AppmaxTransport, TransportResponse } from './appmax-provider.js';
import {
  APPMAX_ENDPOINTS,
  APPMAX_TOKEN_PATH,
  DEFAULT_APPMAX_TIMEOUTS,
} from './appmax-endpoints.js';
import type { AppmaxEndpoints, AppmaxTimeouts } from './appmax-endpoints.js';
import { classifyAppmaxFailure, summarizeRejectedFields } from './appmax-failure.js';
import type { FetchedToken } from './appmax-token-cache.js';

/**
 * The real Appmax transport.
 *
 * The single most important property here is that it never throws for an HTTP
 * status, a timeout or a connection failure. Throwing would collapse "Appmax said
 * no" and "we have no idea whether Appmax acted" into one thing, and everything
 * downstream — whether a retry is safe, whether another provider may be tried —
 * depends on telling those apart.
 *
 * Nothing on this path logs a credential. The access token is carried as a Secret
 * and is written into a header without ever passing through a log line, and
 * validation errors are reported by field name rather than by value, because the
 * value is the customer's document number.
 */

export interface AppmaxCredentials {
  readonly clientId: string;
  readonly clientSecret: Secret;
}

export interface TransportLogger {
  debug(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

const JSON_CONTENT_TYPE = 'application/json';

function transportResultFromError(error: unknown): TransportResult {
  const code = (error as { code?: string } | undefined)?.code ?? '';

  // A connect timeout or a refused connection means the request never reached
  // Appmax, so nothing can have been created and a retry is safe. Anything that
  // failed after the request was written is ambiguous and must stay that way.
  if (['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND'].includes(code)) {
    return { kind: 'connection_error', requestDefinitelyNotDelivered: true };
  }
  if (['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) {
    return { kind: 'timeout' };
  }
  return { kind: 'connection_error' };
}

export class UndiciAppmaxTransport implements AppmaxTransport {
  private readonly agent: Agent;

  private readonly endpoints: AppmaxEndpoints;

  /**
   * `sandboxEndpointOverride` exists so the transport can be exercised over real
   * HTTP against a local server, rather than being tested through a mocked
   * dispatcher that would prove nothing about undici's actual behaviour.
   *
   * It is refused outright for PRODUCTION. The frozen map is the only way to
   * reach a live merchant account, so no configuration mistake and no injected
   * value can redirect production traffic somewhere else.
   */
  public constructor(
    private readonly environment: Environment,
    private readonly credentials: AppmaxCredentials,
    private readonly logger: TransportLogger,
    timeouts: AppmaxTimeouts = DEFAULT_APPMAX_TIMEOUTS,
    sandboxEndpointOverride?: AppmaxEndpoints,
  ) {
    if (sandboxEndpointOverride !== undefined && environment === 'PRODUCTION') {
      throw new Error(
        'Appmax production endpoints are frozen and cannot be overridden. Production traffic must never be redirected.',
      );
    }
    this.endpoints = sandboxEndpointOverride ?? APPMAX_ENDPOINTS[environment];

    this.agent = new Agent({
      connectTimeout: timeouts.connectMilliseconds,
      headersTimeout: timeouts.headersMilliseconds,
      bodyTimeout: timeouts.bodyMilliseconds,
    });
  }

  /**
   * Exchanges the client credentials for an access token.
   *
   * Separate from `request` because it is the one call that carries the client
   * secret and the one that must never be retried on a 401: a rejected credential
   * is a configuration problem, and hammering the endpoint would turn it into a
   * rate-limiting problem as well.
   */
  private async send(options: {
    readonly url: string;
    readonly method: 'GET' | 'POST';
    readonly headers: Record<string, string>;
    readonly body?: string;
  }): Promise<TransportResponse> {
    try {
      const response = await request(options.url, {
        method: options.method,
        headers: options.headers,
        dispatcher: this.agent,
        ...(options.body !== undefined && { body: options.body }),
      });

      const text = await response.body.text();
      return { transport: parseTransport(response.statusCode, text), body: parseBody(text) };
    } catch (error) {
      return { transport: transportResultFromError(error), body: undefined };
    }
  }

  public async fetchToken(): Promise<FetchedToken> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret.expose(),
    }).toString();

    const outcome = await this.send({
      url: `${this.endpoints.authenticationBaseUrl}${APPMAX_TOKEN_PATH}`,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: JSON_CONTENT_TYPE,
      },
      body,
    });

    if (outcome.transport.kind !== 'response' || (outcome.transport.httpStatus ?? 0) >= 400) {
      const failure = classifyAppmaxFailure(outcome.transport);
      this.logger.warn(
        { provider: 'appmax', environment: this.environment, failure: failure.kind },
        'appmax token acquisition failed',
      );
      throw new AppmaxAuthenticationError(failure.summary, failure.kind);
    }

    const token = readToken(outcome.body);
    if (token === undefined) {
      throw new AppmaxAuthenticationError(
        'Appmax returned a token response without a usable access token.',
        'malformed_response',
      );
    }
    return token;
  }

  public async request(options: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly accessToken: Secret;
    readonly body?: unknown;
  }): Promise<TransportResponse> {
    const startedAt = process.hrtime.bigint();

    const response = await this.send({
      url: `${this.endpoints.apiBaseUrl}${options.path}`,
      method: options.method,
      headers: {
        // The only place the token appears. It is exposed into a header value and
        // never into a message, a log field, or an error.
        authorization: `Bearer ${options.accessToken.expose()}`,
        accept: JSON_CONTENT_TYPE,
        ...(options.body !== undefined && { 'content-type': JSON_CONTENT_TYPE }),
      },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    });

    this.logger.debug(
      {
        provider: 'appmax',
        environment: this.environment,
        method: options.method,
        path: options.path,
        httpStatus: response.transport.httpStatus,
        transportKind: response.transport.kind,
        durationMilliseconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      },
      'appmax request completed',
    );

    if (response.transport.kind === 'response' && (response.transport.httpStatus ?? 0) >= 400) {
      const failure = classifyAppmaxFailure(response.transport);
      this.logger.warn(
        {
          provider: 'appmax',
          path: options.path,
          failure: failure.kind,
          httpStatus: failure.httpStatus,
          // Field names only. The values are the customer's.
          rejectedFields: summarizeRejectedFields(response.body),
        },
        'appmax rejected a request',
      );
    }

    return response;
  }
}

function parseTransport(httpStatus: number, text: string): TransportResult {
  if (text.length === 0) {
    return { kind: 'response', httpStatus };
  }
  try {
    JSON.parse(text);
    return { kind: 'response', httpStatus };
  } catch {
    // A body that will not parse is not a status we can act on. Reported as
    // malformed so the outcome taxonomy treats it as ambiguous rather than as a
    // success carrying nothing.
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

function readToken(body: unknown): FetchedToken | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const accessToken = (body as { access_token?: unknown }).access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return undefined;
  }

  const expiresIn = (body as { expires_in?: unknown }).expires_in;
  return {
    accessToken: new Secret(accessToken),
    // A missing or nonsensical lifetime is treated as immediate expiry rather
    // than as forever; the cache then renews on the next call.
    expiresInSeconds:
      typeof expiresIn === 'number' && Number.isSafeInteger(expiresIn) && expiresIn > 0
        ? expiresIn
        : 0,
  };
}

export class AppmaxAuthenticationError extends Error {
  public constructor(
    message: string,
    public readonly kind: string,
  ) {
    super(message);
    this.name = 'AppmaxAuthenticationError';
  }
}
