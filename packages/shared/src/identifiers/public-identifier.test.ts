import { describe, expect, it } from 'vitest';
import {
  assertPublicIdentifier,
  generatePublicIdentifier,
  InvalidPublicIdentifierError,
  isPublicIdentifier,
  parsePublicIdentifier,
  PUBLIC_IDENTIFIER_BODY_LENGTH,
  PUBLIC_IDENTIFIER_ENTROPY_BITS,
  PUBLIC_IDENTIFIER_PREFIXES,
} from './public-identifier.js';
import type { PublicIdentifierKind } from './public-identifier.js';

const ALL_KINDS = Object.keys(PUBLIC_IDENTIFIER_PREFIXES) as PublicIdentifierKind[];

// Kept as a literal rather than imported, so that a change to the production
// pattern has to be made deliberately here too instead of silently agreeing.
const DATABASE_DOMAIN_PATTERN = /^[a-z]{2,12}_[0-9a-hjkmnp-tv-z]{26}$/;

describe('generating public identifiers', () => {
  it('produces the documented shape for every resource kind', () => {
    for (const kind of ALL_KINDS) {
      const identifier = generatePublicIdentifier(kind);
      expect(identifier).toMatch(DATABASE_DOMAIN_PATTERN);
      expect(identifier.startsWith(`${PUBLIC_IDENTIFIER_PREFIXES[kind]}_`)).toBe(true);
      expect(parsePublicIdentifier(identifier).kind).toBe(kind);
    }
  });

  it('produces a body of exactly the declared length', () => {
    const identifier = generatePublicIdentifier('payment');
    expect(parsePublicIdentifier(identifier).body).toHaveLength(PUBLIC_IDENTIFIER_BODY_LENGTH);
    expect(PUBLIC_IDENTIFIER_ENTROPY_BITS).toBe(130);
  });

  it('never emits a character that can be misread', () => {
    const ambiguous = /[ilou]/;
    for (let iteration = 0; iteration < 2000; iteration += 1) {
      expect(parsePublicIdentifier(generatePublicIdentifier('payment')).body).not.toMatch(
        ambiguous,
      );
    }
  });

  it('is not sequential: consecutive identifiers share no common prefix', () => {
    // A ULID or UUIDv7 would share a long leading run because of the embedded
    // timestamp. That run is exactly what this identifier must not have.
    let longestSharedPrefix = 0;
    let previous = parsePublicIdentifier(generatePublicIdentifier('payment')).body;

    for (let iteration = 0; iteration < 1000; iteration += 1) {
      const current = parsePublicIdentifier(generatePublicIdentifier('payment')).body;
      let shared = 0;
      while (shared < current.length && current[shared] === previous[shared]) {
        shared += 1;
      }
      longestSharedPrefix = Math.max(longestSharedPrefix, shared);
      previous = current;
    }

    expect(longestSharedPrefix).toBeLessThan(6);
  });

  it('uses the whole alphabet, so entropy is not silently reduced', () => {
    const seen = new Set<string>();
    for (let iteration = 0; iteration < 2000; iteration += 1) {
      const body = parsePublicIdentifier(generatePublicIdentifier('payment')).body;
      for (const character of body) {
        seen.add(character);
      }
    }
    expect(seen.size).toBe(32);
  });

  it('does not collide across a large sample', () => {
    const generated = new Set<string>();
    const sampleSize = 100_000;
    for (let iteration = 0; iteration < sampleSize; iteration += 1) {
      generated.add(generatePublicIdentifier('payment'));
    }
    expect(generated.size).toBe(sampleSize);
  });
});

describe('validating public identifiers', () => {
  it('accepts a well-formed identifier', () => {
    expect(isPublicIdentifier('org_0123456789abcdefghjkmnpqrs')).toBe(true);
    expect(isPublicIdentifier('org_0123456789abcdefghjkmnpqrs', 'organization')).toBe(true);
  });

  it('rejects an identifier of the wrong kind', () => {
    expect(isPublicIdentifier('org_0123456789abcdefghjkmnpqrs', 'payment')).toBe(false);
    expect(() => assertPublicIdentifier('org_0123456789abcdefghjkmnpqrs', 'payment')).toThrow(
      InvalidPublicIdentifierError,
    );
  });

  it('rejects a body of the wrong length', () => {
    expect(isPublicIdentifier('org_0123456789abcdefghjkmnpqr')).toBe(false);
    expect(isPublicIdentifier('org_0123456789abcdefghjkmnpqrst')).toBe(false);
    expect(isPublicIdentifier('org_')).toBe(false);
  });

  it('rejects characters outside the alphabet', () => {
    for (const ambiguous of ['i', 'l', 'o', 'u']) {
      expect(isPublicIdentifier(`org_${ambiguous}123456789abcdefghjkmnpqr`)).toBe(false);
    }
    expect(isPublicIdentifier('org_0123456789abcdefghjkmnpq!')).toBe(false);
    expect(isPublicIdentifier('org_0123456789abcdefghjkmnpq-')).toBe(false);
  });

  it('rejects uppercase, so one identifier has exactly one spelling', () => {
    expect(isPublicIdentifier('ORG_0123456789abcdefghjkmnpqrs')).toBe(false);
    expect(isPublicIdentifier('org_0123456789ABCDEFGHJKMNPQRS')).toBe(false);
  });

  it('rejects a structurally valid identifier with an unknown prefix', () => {
    expect(isPublicIdentifier('zzz_0123456789abcdefghjkmnpqrs')).toBe(false);
    expect(() => parsePublicIdentifier('zzz_0123456789abcdefghjkmnpqrs')).toThrow(
      /Unknown public identifier prefix/,
    );
  });

  it('rejects malformed input and non-strings without throwing to the caller', () => {
    for (const malformed of [
      '',
      'org',
      '_0123456789abcdefghjkmnpqrs',
      'org0123456789abcdefghjkmnpqrs',
      'org__0123456789abcdefghjkmnpqr',
      ' org_0123456789abcdefghjkmnpqrs',
      'org_0123456789abcdefghjkmnpqrs ',
      'org_0123456789abcdefghjkmnpqrs\n',
      undefined,
      null,
      42,
      {},
      [],
    ]) {
      expect(isPublicIdentifier(malformed)).toBe(false);
    }
  });

  it('rejects a trailing newline, which anchoring must catch', () => {
    // An unanchored pattern would accept this, and the row would never be found.
    expect(() => parsePublicIdentifier('org_0123456789abcdefghjkmnpqrs\n')).toThrow(
      InvalidPublicIdentifierError,
    );
  });
});
