import { createHash } from 'node:crypto';

/**
 * The vocabulary of idempotent request handling.
 *
 * Pure: fingerprinting and the decision about what a repeated key means. Whether
 * a key is already claimed is a database question and lives elsewhere.
 */

export const IDEMPOTENCY_KEY_MAXIMUM_LENGTH = 255;

export class InvalidIdempotencyKeyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidIdempotencyKeyError';
  }
}

export function assertUsableIdempotencyKey(candidate: unknown): string {
  if (typeof candidate !== 'string') {
    throw new InvalidIdempotencyKeyError('An idempotency key must be a string.');
  }
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    throw new InvalidIdempotencyKeyError('An idempotency key must not be empty.');
  }
  if (trimmed.length > IDEMPOTENCY_KEY_MAXIMUM_LENGTH) {
    throw new InvalidIdempotencyKeyError(
      `An idempotency key must be at most ${IDEMPOTENCY_KEY_MAXIMUM_LENGTH} characters.`,
    );
  }
  return trimmed;
}

/**
 * Canonical JSON, so two requests that differ only in key order or whitespace
 * produce the same fingerprint.
 *
 * Without this a client that serialises its object differently on a retry — which
 * many HTTP libraries do — would look like a conflicting request and be refused,
 * turning a correct retry into an error.
 */
export function canonicalize(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right, 'en'));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`).join(',')}}`;
  }
  if (typeof value === 'bigint') {
    return `"${value.toString()}"`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function fingerprintRequest(path: string, body: unknown): Buffer {
  return createHash('sha256')
    .update(`${path}\n${canonicalize(body)}`, 'utf8')
    .digest();
}

/**
 * What a repeated key means.
 *
 * `conflict` is deliberately distinct from `replay`: the same key with a
 * different body is a caller bug, and answering it with the first response would
 * hide the mistake while charging for something they did not ask for.
 */
export type IdempotencyDecision =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'replay'; readonly responseStatus: number; readonly responseBody: unknown }
  | { readonly kind: 'in_flight' }
  /**
   * Claimed, never completed, and now past its expiry.
   *
   * Distinguished from `in_flight` because the answers differ: one means "the
   * first request is still running, retry shortly", and telling a merchant that
   * forever is a lie they cannot act on. Deliberately NOT a licence to claim the
   * key again: the payment it created may have reached a provider and may be
   * payable, and issuing a second one is how a customer ends up with two codes.
   * It resolves when that payment is reconciled.
   */
  | { readonly kind: 'stranded' }
  | { readonly kind: 'conflict' };

export interface ExistingIdempotencyRecord {
  readonly requestFingerprint: Buffer;
  readonly requestPath: string;
  readonly state: 'in_flight' | 'completed';
  readonly responseStatus: number | null;
  readonly responseBody: unknown;
  readonly expiresAt: Date;
}

export function decideForExistingRecord(
  existing: ExistingIdempotencyRecord,
  presentedFingerprint: Buffer,
  presentedPath: string,
  now: Date,
): IdempotencyDecision {
  const isSameRequest =
    existing.requestPath === presentedPath &&
    existing.requestFingerprint.length === presentedFingerprint.length &&
    existing.requestFingerprint.equals(presentedFingerprint);

  if (!isSameRequest) {
    return { kind: 'conflict' };
  }
  if (existing.state === 'in_flight') {
    return now < existing.expiresAt ? { kind: 'in_flight' } : { kind: 'stranded' };
  }
  if (existing.responseStatus === null) {
    // A completed record must carry its response; the schema enforces that, so
    // reaching here means the row was written by something that bypassed it.
    return { kind: 'conflict' };
  }
  return {
    kind: 'replay',
    responseStatus: existing.responseStatus,
    responseBody: existing.responseBody,
  };
}
