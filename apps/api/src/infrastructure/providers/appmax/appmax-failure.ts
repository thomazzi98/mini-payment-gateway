import type { TransportResult } from '../../../domain/provider/provider-outcome.js';

/**
 * What went wrong with an Appmax call, named precisely.
 *
 * The outcome taxonomy in the domain answers "what may we do next". This answers
 * "what actually happened", which is what an operator reads in a log and what
 * decides whether a credential needs rotating or a request needs fixing.
 *
 * Collapsing all of these into "payment failed" is the mistake this exists to
 * prevent: an expired token, a rejected document number and a provider outage
 * need three different responses from three different people.
 */

export const APPMAX_FAILURE_KINDS = [
  'authentication_failure',
  'authorization_failure',
  'validation_failure',
  'not_found',
  'rate_limited',
  'provider_unavailable',
  'timeout',
  'connection_failure',
  'malformed_response',
  'unknown_provider_failure',
] as const;

export type AppmaxFailureKind = (typeof APPMAX_FAILURE_KINDS)[number];

export interface AppmaxFailure {
  readonly kind: AppmaxFailureKind;
  /**
  Safe to log: carries no credential and no customer data.
  */
  readonly summary: string;
  readonly httpStatus?: number;
}

/**
 * Whether the credential should be considered stale.
 *
 * Only a 401 means that. A 403 is a permission the credential does not have,
 * which re-authenticating will not fix and which would otherwise send us into a
 * token-refresh loop against a provider already refusing us.
 */
export function requiresTokenRefresh(failure: AppmaxFailure): boolean {
  return failure.kind === 'authentication_failure';
}

export function classifyAppmaxFailure(result: TransportResult): AppmaxFailure {
  if (result.kind === 'timeout') {
    return { kind: 'timeout', summary: 'Appmax did not answer within the timeout.' };
  }
  if (result.kind === 'connection_error') {
    return {
      kind: 'connection_failure',
      summary:
        result.requestDefinitelyNotDelivered === true
          ? 'The connection to Appmax was refused before the request was sent.'
          : 'The connection to Appmax failed after the request may have been sent.',
    };
  }
  if (result.kind === 'malformed_body') {
    return {
      kind: 'malformed_response',
      summary: 'Appmax returned a body that could not be parsed.',
      ...(result.httpStatus !== undefined && { httpStatus: result.httpStatus }),
    };
  }

  const httpStatus = result.httpStatus ?? 0;
  return { ...failureForStatus(httpStatus), httpStatus };
}

function failureForStatus(httpStatus: number): Omit<AppmaxFailure, 'httpStatus'> {
  if (httpStatus === 401) {
    return {
      kind: 'authentication_failure',
      summary: 'Appmax rejected the access token.',
    };
  }
  if (httpStatus === 403) {
    return {
      kind: 'authorization_failure',
      summary: 'The Appmax credential is not permitted to perform this operation.',
    };
  }
  if (httpStatus === 404) {
    return { kind: 'not_found', summary: 'Appmax does not know the referenced resource.' };
  }
  if (httpStatus === 429) {
    return { kind: 'rate_limited', summary: 'Appmax is rate limiting this credential.' };
  }
  if (httpStatus === 400 || httpStatus === 422) {
    return {
      kind: 'validation_failure',
      summary: 'Appmax rejected the request as invalid.',
    };
  }
  if (httpStatus >= 500) {
    return {
      kind: 'provider_unavailable',
      summary: 'Appmax returned a server error.',
    };
  }
  return {
    kind: 'unknown_provider_failure',
    summary: `Appmax returned an unhandled status ${httpStatus}.`,
  };
}

/**
 * Appmax reports validation problems in an `errors` object keyed by field.
 *
 * Field names are surfaced; values are not. A rejected `document_number` tells an
 * operator what to fix, while the document number itself is the customer's and
 * has no business in a log line.
 */
export function summarizeRejectedFields(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const errors = (body as { errors?: unknown }).errors;
  if (typeof errors !== 'object' || errors === null || Array.isArray(errors)) {
    return [];
  }
  return Object.keys(errors).slice(0, 20);
}
