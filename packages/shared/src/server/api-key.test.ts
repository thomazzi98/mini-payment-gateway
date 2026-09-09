import { describe, expect, it } from 'vitest';
import {
  API_KEY_HASH_BYTE_LENGTH,
  API_KEY_IDENTIFIER_LENGTH,
  API_KEY_LAST_FOUR_LENGTH,
  API_KEY_SECRET_LENGTH,
  describeApiKey,
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
  isApiKeySecretValid,
} from './api-key.js';
import { Secret } from './secret.js';

const PEPPER = new Secret('a-server-side-pepper-that-lives-outside-the-database');
const OTHER_PEPPER = new Secret('a-different-pepper-entirely');

describe('generating an API key', () => {
  it('produces the documented format for each environment', () => {
    expect(generateApiKey('SANDBOX').plaintext.expose()).toMatch(/^mpg_test_[0-9A-Za-z]{44}$/);
    expect(generateApiKey('PRODUCTION').plaintext.expose()).toMatch(/^mpg_live_[0-9A-Za-z]{44}$/);
  });

  it('splits into an indexable identifier and a secret of the declared lengths', () => {
    const generated = generateApiKey('SANDBOX');
    expect(generated.identifier).toHaveLength(API_KEY_IDENTIFIER_LENGTH);
    expect(generated.secret.expose()).toHaveLength(API_KEY_SECRET_LENGTH);
    expect(generated.lastFour).toHaveLength(API_KEY_LAST_FOUR_LENGTH);
    expect(generated.secret.expose().endsWith(generated.lastFour)).toBe(true);
    expect(generated.plaintext.expose()).toContain(generated.identifier);
  });

  it('does not repeat itself', () => {
    const seen = new Set<string>();
    for (let iteration = 0; iteration < 20_000; iteration += 1) {
      seen.add(generateApiKey('SANDBOX').plaintext.expose());
    }
    expect(seen.size).toBe(20_000);
  });

  it('uses the whole base62 alphabet, so rejection sampling has not skewed it', () => {
    const seen = new Set<string>();
    for (let iteration = 0; iteration < 3000; iteration += 1) {
      const secret = generateApiKey('SANDBOX').secret.expose();
      for (const character of secret) {
        seen.add(character);
      }
    }
    expect(seen.size).toBe(62);
  });
});

describe('parsing an API key', () => {
  it('round-trips a generated key', () => {
    const generated = generateApiKey('PRODUCTION');
    const parsed = parseApiKey(generated.plaintext.expose());

    expect(parsed?.environment).toBe('PRODUCTION');
    expect(parsed?.identifier).toBe(generated.identifier);
    expect(parsed?.secret.expose()).toBe(generated.secret.expose());
  });

  it('refuses anything malformed without throwing', () => {
    const valid = generateApiKey('SANDBOX').plaintext.expose();
    for (const malformed of [
      '',
      'mpg_test_',
      'mpg_test_tooshort',
      `${valid}extra`,
      valid.slice(0, -1),
      valid.replace('mpg_', 'xyz_'),
      valid.replace('_test_', '_prod_'),
      valid.replace('_test_', '_TEST_'),
      `${valid}\n`,
      ` ${valid}`,
      valid.replace(/^mpg_test_(.)/, 'mpg_test_-'),
      undefined,
      null,
      42,
      {},
    ]) {
      expect(parseApiKey(malformed)).toBeUndefined();
    }
  });
});

describe('hashing and verification', () => {
  it('produces a stable 32-byte digest', () => {
    const generated = generateApiKey('SANDBOX');
    const first = hashApiKeySecret(generated.identifier, generated.secret, PEPPER);
    const second = hashApiKeySecret(generated.identifier, generated.secret, PEPPER);

    expect(first).toHaveLength(API_KEY_HASH_BYTE_LENGTH);
    expect(first.equals(second)).toBe(true);
  });

  it('never contains the secret itself', () => {
    const generated = generateApiKey('SANDBOX');
    const digest = hashApiKeySecret(generated.identifier, generated.secret, PEPPER);
    expect(digest.toString('utf8')).not.toContain(generated.secret.expose());
    expect(digest.toString('hex')).not.toContain(
      Buffer.from(generated.secret.expose()).toString('hex'),
    );
  });

  it('accepts the correct secret', () => {
    const generated = generateApiKey('SANDBOX');
    const stored = hashApiKeySecret(generated.identifier, generated.secret, PEPPER);
    expect(isApiKeySecretValid(generated.identifier, generated.secret, stored, PEPPER)).toBe(true);
  });

  it('rejects a wrong secret', () => {
    const generated = generateApiKey('SANDBOX');
    const stored = hashApiKeySecret(generated.identifier, generated.secret, PEPPER);
    const impostor = generateApiKey('SANDBOX').secret;
    expect(isApiKeySecretValid(generated.identifier, impostor, stored, PEPPER)).toBe(false);
  });

  it('binds a secret to its own identifier, so it cannot be replayed against another key', () => {
    const generated = generateApiKey('SANDBOX');
    const stored = hashApiKeySecret(generated.identifier, generated.secret, PEPPER);
    const otherIdentifier = generateApiKey('SANDBOX').identifier;
    expect(isApiKeySecretValid(otherIdentifier, generated.secret, stored, PEPPER)).toBe(false);
  });

  it('rejects a correct secret under the wrong pepper', () => {
    const generated = generateApiKey('SANDBOX');
    const stored = hashApiKeySecret(generated.identifier, generated.secret, PEPPER);
    expect(isApiKeySecretValid(generated.identifier, generated.secret, stored, OTHER_PEPPER)).toBe(
      false,
    );
  });

  it('returns false rather than throwing on a stored hash of the wrong length', () => {
    // timingSafeEqual throws on a length mismatch, and a thrown error is itself an
    // observable difference. A truncated column must fail closed and quietly.
    const generated = generateApiKey('SANDBOX');
    expect(
      isApiKeySecretValid(generated.identifier, generated.secret, Buffer.alloc(8), PEPPER),
    ).toBe(false);
    expect(
      isApiKeySecretValid(generated.identifier, generated.secret, Buffer.alloc(0), PEPPER),
    ).toBe(false);
  });

  it('changes completely when a single character of the secret changes', () => {
    const generated = generateApiKey('SANDBOX');
    const exposed = generated.secret.expose();
    const flipped = new Secret(`${exposed.slice(0, -1)}${exposed.endsWith('a') ? 'b' : 'a'}`);
    const original = hashApiKeySecret(generated.identifier, generated.secret, PEPPER);
    const changed = hashApiKeySecret(generated.identifier, flipped, PEPPER);
    expect(original.equals(changed)).toBe(false);
  });
});

describe('describing a key for display', () => {
  it('shows enough to recognise a key and never enough to use it', () => {
    const generated = generateApiKey('SANDBOX');
    const description = describeApiKey(generated.identifier, generated.lastFour);

    expect(description).toContain(generated.identifier);
    expect(description).toContain(generated.lastFour);
    expect(description).not.toContain(generated.secret.expose());
    expect(description).not.toContain(generated.plaintext.expose());
  });
});
