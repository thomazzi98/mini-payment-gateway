import { describe, expect, it } from 'vitest';
import {
  APPMAX_FAILURE_KINDS,
  classifyAppmaxFailure,
  requiresTokenRefresh,
  summarizeRejectedFields,
} from './appmax-failure.js';
import type { AppmaxFailureKind } from './appmax-failure.js';

function kindOf(...args: Parameters<typeof classifyAppmaxFailure>): AppmaxFailureKind {
  return classifyAppmaxFailure(...args).kind;
}

describe('naming what went wrong', () => {
  it('distinguishes an expired token from a permission the credential lacks', () => {
    // These need different people to do different things. Collapsing them would
    // send the system into a refresh loop against a provider already refusing us.
    expect(kindOf({ kind: 'response', httpStatus: 401 })).toBe('authentication_failure');
    expect(kindOf({ kind: 'response', httpStatus: 403 })).toBe('authorization_failure');
  });

  it('names a rejected request as validation rather than as a generic failure', () => {
    expect(kindOf({ kind: 'response', httpStatus: 400 })).toBe('validation_failure');
    expect(kindOf({ kind: 'response', httpStatus: 422 })).toBe('validation_failure');
  });

  it('names rate limiting, so it is not mistaken for an outage', () => {
    expect(kindOf({ kind: 'response', httpStatus: 429 })).toBe('rate_limited');
  });

  it('names a provider outage separately from a rejected request', () => {
    for (const httpStatus of [500, 502, 503, 504]) {
      expect(kindOf({ kind: 'response', httpStatus })).toBe('provider_unavailable');
    }
  });

  it('names a missing resource', () => {
    expect(kindOf({ kind: 'response', httpStatus: 404 })).toBe('not_found');
  });

  it('names a timeout and a connection failure distinctly', () => {
    expect(kindOf({ kind: 'timeout' })).toBe('timeout');
    expect(kindOf({ kind: 'connection_error' })).toBe('connection_failure');
  });

  it('says whether a connection failure reached Appmax at all', () => {
    const refused = classifyAppmaxFailure({
      kind: 'connection_error',
      requestDefinitelyNotDelivered: true,
    });
    const midFlight = classifyAppmaxFailure({ kind: 'connection_error' });

    expect(refused.summary).toContain('before the request was sent');
    expect(midFlight.summary).toContain('may have been sent');
  });

  it('names an unparseable body', () => {
    expect(kindOf({ kind: 'malformed_body', httpStatus: 200 })).toBe('malformed_response');
  });

  it('falls back to an explicitly unknown failure for a status nobody mapped', () => {
    expect(kindOf({ kind: 'response', httpStatus: 418 })).toBe('unknown_provider_failure');
    expect(kindOf({ kind: 'response' })).toBe('unknown_provider_failure');
  });

  it('only ever produces a declared kind', () => {
    for (const httpStatus of [200, 301, 400, 401, 403, 404, 418, 429, 500, 599]) {
      expect(APPMAX_FAILURE_KINDS).toContain(kindOf({ kind: 'response', httpStatus }));
    }
  });

  it('carries the status through for the operator reading the log', () => {
    expect(classifyAppmaxFailure({ kind: 'response', httpStatus: 429 }).httpStatus).toBe(429);
  });
});

describe('deciding whether the credential is stale', () => {
  it('refreshes only after a rejected token', () => {
    const refreshing = APPMAX_FAILURE_KINDS.filter((kind) =>
      requiresTokenRefresh({ kind, summary: '' }),
    );
    expect(refreshing).toEqual(['authentication_failure']);
  });

  it('does not refresh on a permission failure', () => {
    // Re-authenticating cannot grant a permission the credential does not have.
    expect(requiresTokenRefresh({ kind: 'authorization_failure', summary: '' })).toBe(false);
  });
});

describe('summarizing what Appmax rejected', () => {
  it('reports field names so an operator knows what to fix', () => {
    expect(
      summarizeRejectedFields({ errors: { document_number: ['is invalid'], email: ['required'] } }),
    ).toEqual(['document_number', 'email']);
  });

  it('never reports the values, which are the customer’s', () => {
    const summary = summarizeRejectedFields({
      errors: { document_number: ['25226493029 is invalid'] },
    });
    expect(summary.join(' ')).not.toContain('25226493029');
  });

  it('returns nothing for a body with no errors object', () => {
    for (const body of [{}, { errors: null }, { errors: [] }, 'text', null, undefined]) {
      expect(summarizeRejectedFields(body)).toEqual([]);
    }
  });

  it('bounds how many fields it will report', () => {
    const manyFields = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [`field_${index}`, ['bad']]),
    );
    expect(summarizeRejectedFields({ errors: manyFields })).toHaveLength(20);
  });
});
