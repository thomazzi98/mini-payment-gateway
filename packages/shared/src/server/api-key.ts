import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Secret } from './secret.js';

/**
 * An API key is two parts joined together: a public identifier that indexes the
 * row, and a secret that proves possession.
 *
 *   mpg_test_<12-character identifier><32-character secret>
 *
 * Splitting them is what makes verification a single indexed lookup instead of a
 * scan comparing a hash against every row. The identifier is safe to log, to keep
 * in an audit trail, and to show in a dashboard; the secret is never stored.
 */

const KEY_PREFIX = 'mpg';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export const API_KEY_IDENTIFIER_LENGTH = 12;
export const API_KEY_SECRET_LENGTH = 32;
export const API_KEY_LAST_FOUR_LENGTH = 4;
export const API_KEY_HASH_BYTE_LENGTH = 32;

export const API_KEY_ENVIRONMENT_LABELS = { SANDBOX: 'test', PRODUCTION: 'live' } as const;
export type ApiKeyEnvironment = keyof typeof API_KEY_ENVIRONMENT_LABELS;

const LABEL_TO_ENVIRONMENT = new Map<string, ApiKeyEnvironment>(
  Object.entries(API_KEY_ENVIRONMENT_LABELS).map(([environment, label]) => [
    label,
    environment as ApiKeyEnvironment,
  ]),
);

// 62 does not divide 256, so `byte % 62` would favour the first eight symbols.
// Rejecting the tail of the byte range keeps every symbol equally likely.
const LARGEST_UNBIASED_BYTE = Math.floor(256 / BASE62.length) * BASE62.length;

function randomBase62(length: number): string {
  const characters: string[] = [];
  while (characters.length < length) {
    const candidateBytes = randomBytes(length * 2);
    for (const byte of candidateBytes) {
      if (byte < LARGEST_UNBIASED_BYTE && characters.length < length) {
        characters.push(BASE62.charAt(byte % BASE62.length));
      }
    }
  }
  return characters.join('');
}

export interface GeneratedApiKey {
  /**
   * Shown to the operator exactly once and never persisted.
   */
  readonly plaintext: Secret;
  readonly identifier: string;
  readonly secret: Secret;
  readonly lastFour: string;
  readonly environment: ApiKeyEnvironment;
}

export function generateApiKey(environment: ApiKeyEnvironment): GeneratedApiKey {
  const identifier = randomBase62(API_KEY_IDENTIFIER_LENGTH);
  const secret = randomBase62(API_KEY_SECRET_LENGTH);
  const label = API_KEY_ENVIRONMENT_LABELS[environment];

  return {
    plaintext: new Secret(`${KEY_PREFIX}_${label}_${identifier}${secret}`),
    identifier,
    secret: new Secret(secret),
    lastFour: secret.slice(-API_KEY_LAST_FOUR_LENGTH),
    environment,
  };
}

export interface ParsedApiKey {
  readonly environment: ApiKeyEnvironment;
  readonly identifier: string;
  readonly secret: Secret;
}

const API_KEY_PATTERN = new RegExp(
  `^${KEY_PREFIX}_(live|test)_([0-9A-Za-z]{${API_KEY_IDENTIFIER_LENGTH}})([0-9A-Za-z]{${API_KEY_SECRET_LENGTH}})$`,
);

/**
 * Returns undefined rather than throwing: a malformed key is an ordinary
 * unauthenticated request, not an exceptional condition, and every rejection path
 * should look identical to a caller probing for differences.
 */
export function parseApiKey(candidate: unknown): ParsedApiKey | undefined {
  if (typeof candidate !== 'string') {
    return undefined;
  }
  const match = API_KEY_PATTERN.exec(candidate);
  if (match === null) {
    return undefined;
  }

  const [, label, identifier, secret] = match;
  if (label === undefined || identifier === undefined || secret === undefined) {
    return undefined;
  }
  const environment = LABEL_TO_ENVIRONMENT.get(label);
  if (environment === undefined) {
    return undefined;
  }

  return { environment, identifier, secret: new Secret(secret) };
}

/**
 * HMAC-SHA256 under a server-side pepper rather than a password hash.
 *
 * A key is verified on every single request, so an intentionally slow hash would
 * be a self-inflicted denial of service. The usual reason to prefer argon2 — that
 * a stolen database allows offline guessing — does not apply here: the secret is
 * 32 random base62 characters, roughly 190 bits, and the pepper lives outside the
 * database, so a dump on its own yields nothing to attack.
 *
 * The identifier is mixed into the input so a secret is bound to its own row and
 * cannot be replayed against a different key.
 */
export function hashApiKeySecret(identifier: string, secret: Secret, pepper: Secret): Buffer {
  return createHmac('sha256', pepper.expose())
    .update(`${identifier}.${secret.expose()}`, 'utf8')
    .digest();
}

export function isApiKeySecretValid(
  identifier: string,
  secret: Secret,
  storedHash: Buffer,
  pepper: Secret,
): boolean {
  const candidateHash = hashApiKeySecret(identifier, secret, pepper);
  // Length is compared first because timingSafeEqual throws on a length mismatch,
  // and a thrown error would itself be an observable difference.
  if (candidateHash.length !== storedHash.length) {
    return false;
  }
  return timingSafeEqual(candidateHash, storedHash);
}

/**
 * For dashboards and audit logs: enough to recognise a key, never enough to use it.
 */
export function describeApiKey(identifier: string, lastFour: string): string {
  return `${KEY_PREFIX}_..._${identifier}...${lastFour}`;
}
