import type { Secret } from '@gateway/shared/server';

/**
 * Appmax tokens last an hour and there is no refresh token, so one is fetched and
 * held until shortly before it lapses.
 *
 * The part worth writing carefully is the stampede. Without it, the moment a token
 * expires every in-flight request notices at once and every one of them asks for a
 * new token — dozens of identical calls, several of which may be rejected for
 * rate limiting, at exactly the moment the system is busiest. Holding the pending
 * promise means the first caller fetches and the rest await that same fetch.
 */

/**
 * Renewed early, so a token never expires between being read and being used.
 */
const RENEWAL_MARGIN_MILLISECONDS = 60_000;

export interface FetchedToken {
  readonly accessToken: Secret;
  readonly expiresInSeconds: number;
}

export interface Clock {
  now(): number;
}

const systemMillisecondClock: Clock = { now: () => Date.now() };

interface HeldToken {
  readonly accessToken: Secret;
  readonly renewAtMilliseconds: number;
}

export class AppmaxTokenCache {
  #held: HeldToken | undefined;
  #inFlight: Promise<Secret> | undefined;

  public constructor(
    private readonly fetchToken: () => Promise<FetchedToken>,
    private readonly clock: Clock = systemMillisecondClock,
  ) {}

  private async fetchAndHold(): Promise<Secret> {
    const fetched = await this.fetchToken();

    // A token that has already expired, or one with an implausible lifetime, is
    // held for a single renewal margin rather than trusted.
    const lifetimeMilliseconds = Math.max(fetched.expiresInSeconds, 0) * 1000;
    const renewAfter = Math.max(lifetimeMilliseconds - RENEWAL_MARGIN_MILLISECONDS, 0);

    this.#held = {
      accessToken: fetched.accessToken,
      renewAtMilliseconds: this.clock.now() + renewAfter,
    };

    return fetched.accessToken;
  }

  public async currentToken(): Promise<Secret> {
    const held = this.#held;
    if (held !== undefined && this.clock.now() < held.renewAtMilliseconds) {
      return held.accessToken;
    }

    // Every caller that arrives while a fetch is running awaits that same fetch.
    this.#inFlight ??= this.fetchAndHold();

    try {
      return await this.#inFlight;
    } finally {
      this.#inFlight = undefined;
    }
  }

  /**
   * Called when a request is refused as unauthenticated, so the next call re-fetches.
   */
  public invalidate(): void {
    this.#held = undefined;
  }
}
