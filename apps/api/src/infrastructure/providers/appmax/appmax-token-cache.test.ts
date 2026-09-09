import { Secret } from '@gateway/shared/server';
import { describe, expect, it } from 'vitest';
import { AppmaxTokenCache } from './appmax-token-cache.js';
import type { Clock, FetchedToken } from './appmax-token-cache.js';

function movableClock(): Clock & { advance(milliseconds: number): void } {
  let current = 1_000_000;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

function tokenSource(expiresInSeconds = 3600) {
  let issued = 0;
  const pending: (() => void)[] = [];

  return {
    get issuedCount() {
      return issued;
    },
    releaseAll(): void {
      for (const release of pending.splice(0)) {
        release();
      }
    },
    /**
     * Resolves immediately.
     */
    fetch: (): Promise<FetchedToken> => {
      issued += 1;
      return Promise.resolve({
        accessToken: new Secret(`token-${issued}`),
        expiresInSeconds,
      });
    },
    /**
     * Waits until releaseAll is called, so a stampede can be observed.
     */
    fetchSlowly: async (): Promise<FetchedToken> => {
      issued += 1;
      const mine = issued;
      await new Promise<void>((resolve) => {
        pending.push(resolve);
      });
      return { accessToken: new Secret(`token-${mine}`), expiresInSeconds };
    },
  };
}

describe('holding an Appmax token', () => {
  it('fetches once and reuses it', async () => {
    const source = tokenSource();
    const cache = new AppmaxTokenCache(source.fetch, movableClock());

    const first = await cache.currentToken();
    const second = await cache.currentToken();
    expect(first.expose()).toBe('token-1');
    expect(second.expose()).toBe('token-1');
    expect(source.issuedCount).toBe(1);
  });

  it('renews before the token actually expires', async () => {
    // Renewing exactly at expiry would leave a token that lapses between being
    // read and being used on the next request.
    const clock = movableClock();
    const source = tokenSource(3600);
    const cache = new AppmaxTokenCache(source.fetch, clock);

    await cache.currentToken();

    clock.advance(3_600_000 - 61_000);
    const stillValid = await cache.currentToken();
    expect(stillValid.expose()).toBe('token-1');

    clock.advance(2000);
    const renewed = await cache.currentToken();
    expect(renewed.expose()).toBe('token-2');
    expect(source.issuedCount).toBe(2);
  });

  it('re-fetches after being invalidated by a rejected request', async () => {
    const source = tokenSource();
    const cache = new AppmaxTokenCache(source.fetch, movableClock());

    await cache.currentToken();
    cache.invalidate();

    const reissued = await cache.currentToken();
    expect(reissued.expose()).toBe('token-2');
  });

  it('does not stampede: twenty simultaneous callers cause one fetch', async () => {
    // The failure this prevents: the moment a token expires, every in-flight
    // request notices at once and each asks for its own, at exactly the moment
    // the provider is most likely to rate-limit us.
    const source = tokenSource();
    const cache = new AppmaxTokenCache(source.fetchSlowly, movableClock());

    const waiting = Promise.all(Array.from({ length: 20 }, async () => cache.currentToken()));
    source.releaseAll();
    const tokens = await waiting;

    expect(source.issuedCount).toBe(1);
    expect(tokens.every((token) => token.expose() === 'token-1')).toBe(true);
  });

  it('lets the next caller retry after a failed fetch', async () => {
    // A rejected fetch must not poison the cache into never trying again.
    let attempt = 0;
    const cache = new AppmaxTokenCache(() => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(new Error('the provider refused'));
      }
      return Promise.resolve({
        accessToken: new Secret('token-after-retry'),
        expiresInSeconds: 3600,
      });
    }, movableClock());

    await expect(cache.currentToken()).rejects.toThrow('the provider refused');
    const afterRetry = await cache.currentToken();
    expect(afterRetry.expose()).toBe('token-after-retry');
  });

  it('does not trust an implausible lifetime', async () => {
    // A zero or negative expires_in must not produce a token held forever.
    const clock = movableClock();
    const source = tokenSource(0);
    const cache = new AppmaxTokenCache(source.fetch, clock);

    await cache.currentToken();
    clock.advance(1);
    await cache.currentToken();

    expect(source.issuedCount).toBe(2);
  });

  it('never exposes the token through an accidental log route', () => {
    const secret = new Secret('token-1');
    expect(String(secret)).toBe('[redacted]');
    expect(JSON.stringify({ accessToken: secret })).toBe('{"accessToken":"[redacted]"}');
  });
});
