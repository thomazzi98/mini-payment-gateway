/**
 * The one shape every error leaves through.
 *
 * Closed unions rather than free text, so a merchant can switch on `code` and a
 * new one cannot be added without the compiler pointing at every consumer.
 *
 * Nothing internal escapes. No stack, no SQL, no constraint name, no provider
 * message. The legacy system returned its raw driver error on a 500, which hands
 * an attacker the schema and sometimes the connection string.
 */

export type ErrorType =
  | 'authentication_error'
  | 'authorization_error'
  | 'invalid_request_error'
  | 'conflict_error'
  | 'provider_error'
  | 'api_error';

export type ErrorCode =
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'insufficient_scope'
  | 'environment_mismatch'
  | 'missing_idempotency_key'
  | 'invalid_request'
  | 'amount_exceeds_limit'
  | 'idempotency_key_reuse'
  | 'idempotency_key_in_flight'
  | 'duplicate_merchant_reference'
  | 'no_provider_available'
  | 'not_found'
  | 'provider_rejected'
  | 'provider_outcome_unknown'
  | 'internal_error';

export interface ApiErrorBody {
  readonly error: {
    readonly type: ErrorType;
    readonly code: ErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly param?: string;
    readonly retryable: boolean;
  };
}

export interface ApiError {
  readonly httpStatus: number;
  readonly body: ApiErrorBody;
}

export function apiError(options: {
  readonly httpStatus: number;
  readonly type: ErrorType;
  readonly code: ErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly param?: string;
  readonly retryable?: boolean;
}): ApiError {
  return {
    httpStatus: options.httpStatus,
    body: {
      error: {
        type: options.type,
        code: options.code,
        message: options.message,
        requestId: options.requestId,
        retryable: options.retryable ?? false,
        ...(options.param !== undefined && { param: options.param }),
      },
    },
  };
}

/**
 * The answer to anything that went wrong in a way the route did not anticipate.
 *
 * Deliberately says nothing. The legacy system returned its raw driver error on a
 * 500, which hands an attacker the schema and sometimes the connection string;
 * Fastify's own default does the same with whatever message the exception
 * carried. The detail belongs in the log, addressable by the request id, which is
 * the only thing this returns that the caller can act on.
 */
export function internalError(requestId: string): ApiError {
  return apiError({
    httpStatus: 500,
    type: 'api_error',
    code: 'internal_error',
    message: 'The request could not be completed.',
    requestId,
  });
}

/**
 * Every authentication refusal says the same thing.
 *
 * Telling a caller that a key exists but is revoked, or belongs to another
 * environment, turns the endpoint into a probe for which keys are real.
 */
export function authenticationRefused(requestId: string): ApiError {
  return apiError({
    httpStatus: 401,
    type: 'authentication_error',
    code: 'invalid_api_key',
    message: 'The API key is missing, malformed, or not usable.',
    requestId,
  });
}
