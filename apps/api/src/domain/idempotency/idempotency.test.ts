import { describe, expect, it } from 'vitest';
import {
  assertUsableIdempotencyKey,
  canonicalize,
  decideForExistingRecord,
  fingerprintRequest,
  IDEMPOTENCY_KEY_MAXIMUM_LENGTH,
  InvalidIdempotencyKeyError,
} from './idempotency.js';
import type { ExistingIdempotencyRecord } from './idempotency.js';

const PATH = '/v1/payments';
const BODY = { amount: 10_000, currency: 'BRL', reference: 'order-1' };

function recordFor(overrides: Partial<ExistingIdempotencyRecord> = {}): ExistingIdempotencyRecord {
  return {
    requestFingerprint: fingerprintRequest(PATH, BODY),
    requestPath: PATH,
    state: 'completed',
    responseStatus: 201,
    responseBody: { id: 'pay_0123456789abcdefghjkmnpqrs' },
    ...overrides,
  };
}

describe('idempotency keys', () => {
  it('accepts an ordinary key and trims it', () => {
    expect(assertUsableIdempotencyKey('  order-1  ')).toBe('order-1');
  });

  it('refuses an empty, whitespace-only, oversized or non-string key', () => {
    for (const invalid of [
      '',
      ' '.repeat(3),
      'x'.repeat(IDEMPOTENCY_KEY_MAXIMUM_LENGTH + 1),
      42,
      null,
    ]) {
      expect(() => assertUsableIdempotencyKey(invalid)).toThrow(InvalidIdempotencyKeyError);
    }
  });

  it('accepts a key of exactly the maximum length', () => {
    const atLimit = 'x'.repeat(IDEMPOTENCY_KEY_MAXIMUM_LENGTH);
    expect(assertUsableIdempotencyKey(atLimit)).toBe(atLimit);
  });
});

describe('fingerprinting a request', () => {
  it('ignores key order, so a retry serialised differently still matches', () => {
    // Many HTTP clients do not preserve property order across retries. Without
    // canonicalisation a correct retry would look like a conflicting request.
    const first = fingerprintRequest(PATH, { amount: 1, currency: 'BRL' });
    const second = fingerprintRequest(PATH, { currency: 'BRL', amount: 1 });
    expect(first.equals(second)).toBe(true);
  });

  it('ignores properties that are explicitly undefined', () => {
    const withUndefined = fingerprintRequest(PATH, { amount: 1, note: undefined });
    const without = fingerprintRequest(PATH, { amount: 1 });
    expect(withUndefined.equals(without)).toBe(true);
  });

  it('distinguishes a different amount', () => {
    const first = fingerprintRequest(PATH, { amount: 10_000 });
    const second = fingerprintRequest(PATH, { amount: 10_001 });
    expect(first.equals(second)).toBe(false);
  });

  it('distinguishes a different path under the same key', () => {
    const payments = fingerprintRequest('/v1/payments', BODY);
    const refunds = fingerprintRequest('/v1/refunds', BODY);
    expect(payments.equals(refunds)).toBe(false);
  });

  it('distinguishes a string from a number, so "1" and 1 are not the same request', () => {
    const asNumber = fingerprintRequest(PATH, { amount: 1 });
    const asString = fingerprintRequest(PATH, { amount: '1' });
    expect(asNumber.equals(asString)).toBe(false);
  });

  it('preserves array order, because order is meaningful in a request', () => {
    const first = fingerprintRequest(PATH, { items: ['a', 'b'] });
    const second = fingerprintRequest(PATH, { items: ['b', 'a'] });
    expect(first.equals(second)).toBe(false);
  });

  it('canonicalizes nested objects, not just the top level', () => {
    expect(canonicalize({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it('renders a bigint as a string rather than throwing', () => {
    // Money is bigint internally; a fingerprint must never crash on one.
    expect(canonicalize({ amountMinor: 10_000n })).toBe('{"amountMinor":"10000"}');
  });

  it('produces a 32-byte digest', () => {
    expect(fingerprintRequest(PATH, BODY)).toHaveLength(32);
  });
});

describe('deciding what a repeated key means', () => {
  it('replays the stored response for an identical completed request', () => {
    const decision = decideForExistingRecord(recordFor(), fingerprintRequest(PATH, BODY), PATH);

    expect(decision).toEqual({
      kind: 'replay',
      responseStatus: 201,
      responseBody: { id: 'pay_0123456789abcdefghjkmnpqrs' },
    });
  });

  it('reports a conflict when the same key carries a different body', () => {
    // Answering with the first response would hide the caller's mistake while
    // charging for something they did not ask for.
    const decision = decideForExistingRecord(
      recordFor(),
      fingerprintRequest(PATH, { ...BODY, amount: 99_999 }),
      PATH,
    );

    expect(decision).toEqual({ kind: 'conflict' });
  });

  it('reports a conflict when the same key is used on a different endpoint', () => {
    const decision = decideForExistingRecord(
      recordFor(),
      fingerprintRequest('/v1/refunds', BODY),
      '/v1/refunds',
    );

    expect(decision).toEqual({ kind: 'conflict' });
  });

  it('reports in flight while the first request is still running', () => {
    const decision = decideForExistingRecord(
      recordFor({ state: 'in_flight', responseStatus: null, responseBody: null }),
      fingerprintRequest(PATH, BODY),
      PATH,
    );

    expect(decision).toEqual({ kind: 'in_flight' });
  });

  it('checks the request before the state, so a conflicting retry is never told in flight', () => {
    const decision = decideForExistingRecord(
      recordFor({ state: 'in_flight', responseStatus: null, responseBody: null }),
      fingerprintRequest(PATH, { ...BODY, amount: 1 }),
      PATH,
    );

    expect(decision).toEqual({ kind: 'conflict' });
  });

  it('refuses to replay a completed record with no stored response', () => {
    // The schema forbids this shape, so reaching it means something bypassed the
    // database. Failing closed is the only safe reading.
    const decision = decideForExistingRecord(
      recordFor({ responseStatus: null }),
      fingerprintRequest(PATH, BODY),
      PATH,
    );

    expect(decision).toEqual({ kind: 'conflict' });
  });
});
