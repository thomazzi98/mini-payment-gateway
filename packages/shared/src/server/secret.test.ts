/*
 * This file deliberately does the things the rest of the codebase must never do:
 * interpolate a secret into a template, hand it to console.log, and serialize it.
 * That is the point — each is a route by which a real secret would otherwise reach
 * a log, and the assertions prove Secret closes them. The rules that normally
 * forbid these patterns are therefore disabled here, and only here.
 */
/* eslint-disable @typescript-eslint/restrict-template-expressions, unicorn/no-useless-template-literals, no-console */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isSecret, Secret } from './secret.js';

const SENSITIVE = 'mpg_test_AbCdEfGhIjKl0123456789abcdefghijklmnop';

describe('Secret', () => {
  it('returns the real value only through expose()', () => {
    expect(new Secret(SENSITIVE).expose()).toBe(SENSITIVE);
  });

  it('identifies itself', () => {
    expect(isSecret(new Secret('x'))).toBe(true);
    expect(isSecret('x')).toBe(false);
    expect(isSecret(undefined)).toBe(false);
  });

  describe('never leaks through a route that reaches a log', () => {
    const secret = new Secret(SENSITIVE);

    it('String() and .toString()', () => {
      expect(String(secret)).toBe('[redacted]');
      expect(secret.toString()).toBe('[redacted]');
    });

    it('template interpolation, which is the most common accident', () => {
      expect(`key=${secret}`).toBe('key=[redacted]');
      expect(`${secret}`).not.toContain('AbCdEfGhIjKl');
    });

    it('string concatenation', () => {
      expect('key=' + String(secret)).toBe('key=[redacted]');
    });

    it('JSON.stringify, directly and nested', () => {
      expect(JSON.stringify(secret)).toBe('"[redacted]"');
      expect(JSON.stringify({ apiKey: secret, nested: { deeper: secret } })).toBe(
        '{"apiKey":"[redacted]","nested":{"deeper":"[redacted]"}}',
      );
    });

    it('util.inspect, which console.log uses', () => {
      expect(inspect(secret)).toBe('[redacted]');
      expect(inspect({ apiKey: secret }, { depth: 5 })).toContain('[redacted]');
      expect(inspect({ apiKey: secret }, { depth: 5 })).not.toContain('AbCdEfGhIjKl');
    });

    it('console.log', () => {
      const written: string[] = [];
      const original = console.log;
      console.log = (...values: unknown[]) => {
        written.push(values.map((value) => inspect(value)).join(' '));
      };
      try {
        console.log('api key is', secret);
      } finally {
        console.log = original;
      }
      expect(written.join('\n')).not.toContain(SENSITIVE);
      expect(written.join('\n')).toContain('[redacted]');
    });

    it('enumeration: the value is a private field, so spreading finds nothing', () => {
      expect(Object.keys(secret)).toEqual([]);
      expect(JSON.stringify({ ...secret })).toBe('{}');
      expect(inspect({ ...secret })).not.toContain(SENSITIVE);
    });

    it('Object.entries and structured serialization of a wrapper object', () => {
      const payload = { identifier: 'AbCdEfGhIjKl', secret };
      const serialized = JSON.stringify(Object.fromEntries(Object.entries(payload)));
      expect(serialized).toContain('AbCdEfGhIjKl');
      expect(serialized).not.toContain(SENSITIVE);
    });
  });

  it('still compares by identity, so it cannot be used as a bare string by mistake', () => {
    const secret = new Secret(SENSITIVE);
    expect(secret === (SENSITIVE as unknown)).toBe(false);
  });
});
