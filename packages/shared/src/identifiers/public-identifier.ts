/**
 * Identifiers that leave this system are opaque and random.
 *
 * They are deliberately NOT ULIDs or UUIDv7: those embed a creation timestamp,
 * which both orders them and tells an outside observer when a resource was made
 * and roughly how many were made near it. Database primary keys remain UUIDv7 for
 * index locality; that ordering simply never reaches an API response.
 */

// Crockford base32: no I, L, O or U, so a transcribed identifier cannot be
// confused with 1 or 0, and the alphabet survives being read aloud.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ALPHABET_MASK = 0b1_1111;

export const PUBLIC_IDENTIFIER_BODY_LENGTH = 26;

/**
 * 26 characters of a 32-symbol alphabet is 130 bits. At a billion identifiers per
 * resource type the chance of a single collision stays far below 10^-20, so
 * uniqueness needs no coordination — though the database still enforces it.
 */
export const PUBLIC_IDENTIFIER_ENTROPY_BITS = PUBLIC_IDENTIFIER_BODY_LENGTH * 5;

export const PUBLIC_IDENTIFIER_PREFIXES = {
  organization: 'org',
  user: 'usr',
  apiKey: 'key',
  payment: 'pay',
  paymentAttempt: 'att',
  refund: 'ref',
  provider: 'prv',
  providerCredential: 'crd',
  webhookEndpoint: 'whe',
  webhookDelivery: 'whd',
  notificationChannel: 'nch',
  idempotencyRecord: 'idm',
} as const;

export type PublicIdentifierKind = keyof typeof PUBLIC_IDENTIFIER_PREFIXES;
export type PublicIdentifierPrefix = (typeof PUBLIC_IDENTIFIER_PREFIXES)[PublicIdentifierKind];

const PREFIX_TO_KIND = new Map<string, PublicIdentifierKind>(
  Object.entries(PUBLIC_IDENTIFIER_PREFIXES).map(([kind, prefix]) => [
    prefix,
    kind as PublicIdentifierKind,
  ]),
);

// Anchored, and case-sensitive on purpose: accepting uppercase would make two
// spellings of the same identifier, and only one of them would match a stored row.
const PUBLIC_IDENTIFIER_PATTERN = /^[a-z]{2,12}_[0-9a-hjkmnp-tv-z]{26}$/;

export class InvalidPublicIdentifierError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidPublicIdentifierError';
  }
}

function randomBodyCharacters(): string {
  const bytes = new Uint8Array(PUBLIC_IDENTIFIER_BODY_LENGTH);
  crypto.getRandomValues(bytes);

  // The alphabet has exactly 32 symbols and a byte has 256 values, so masking to
  // five bits is uniform. A modulo against a non-power-of-two would not be.
  let body = '';
  for (const byte of bytes) {
    body += ALPHABET[byte & ALPHABET_MASK];
  }
  return body;
}

export function generatePublicIdentifier(kind: PublicIdentifierKind): string {
  return `${PUBLIC_IDENTIFIER_PREFIXES[kind]}_${randomBodyCharacters()}`;
}

export interface ParsedPublicIdentifier {
  readonly kind: PublicIdentifierKind;
  readonly prefix: PublicIdentifierPrefix;
  readonly body: string;
}

export function parsePublicIdentifier(candidate: unknown): ParsedPublicIdentifier {
  if (typeof candidate !== 'string') {
    throw new InvalidPublicIdentifierError('A public identifier must be a string.');
  }
  if (!PUBLIC_IDENTIFIER_PATTERN.test(candidate)) {
    throw new InvalidPublicIdentifierError(
      'A public identifier must look like org_0123456789abcdefghjkmnpqrs.',
    );
  }

  const separatorIndex = candidate.indexOf('_');
  const prefix = candidate.slice(0, separatorIndex);
  const kind = PREFIX_TO_KIND.get(prefix);

  if (kind === undefined) {
    throw new InvalidPublicIdentifierError(`Unknown public identifier prefix: ${prefix}.`);
  }

  return {
    kind,
    prefix: prefix as PublicIdentifierPrefix,
    body: candidate.slice(separatorIndex + 1),
  };
}

export function isPublicIdentifier(candidate: unknown, kind?: PublicIdentifierKind): boolean {
  try {
    const parsed = parsePublicIdentifier(candidate);
    return kind === undefined || parsed.kind === kind;
  } catch {
    return false;
  }
}

/**
 * Used at API boundaries where a caller supplied an identifier for a specific
 * resource. Passing a payment identifier where a refund was expected is a caller
 * error worth reporting precisely rather than turning into a 404 later.
 */
export function assertPublicIdentifier(candidate: unknown, kind: PublicIdentifierKind): string {
  const parsed = parsePublicIdentifier(candidate);
  if (parsed.kind !== kind) {
    throw new InvalidPublicIdentifierError(
      `Expected a ${kind} identifier (${PUBLIC_IDENTIFIER_PREFIXES[kind]}_...) but received a ${parsed.kind} identifier.`,
    );
  }
  return candidate as string;
}
