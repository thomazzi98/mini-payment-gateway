import { canServeMethod, hasCapability } from '../domain/provider/provider-capability.js';
import type { PaymentMethod, ProviderDescriptor } from '../domain/provider/provider-capability.js';
import type { PixPaymentProvider } from './ports/payment-provider.js';

/**
 * Chooses which provider serves a payment.
 *
 * The payment domain asks for a method and a currency and gets back something
 * that can issue an instrument. It never names a provider, so adding one — a card
 * processor, a crypto one — is a registration rather than a change to any caller.
 *
 * Selection is by declared capability, not by a hard-coded list. A provider that
 * does not declare `pix.create` is never offered a Pix payment, which is why an
 * adapter never has to implement a method it would only refuse.
 */

export interface RegisteredProvider {
  readonly descriptor: ProviderDescriptor;
  /**
   * The environment this registration's credentials belong to.
   *
   * A provider built from sandbox credentials talks to sandbox endpoints and
   * issues codes nobody can pay. Serving those to a production payment would tell
   * a merchant their customer had been given something to pay when they had not,
   * so the environment is matched rather than assumed.
   */
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly pix?: PixPaymentProvider;
  /**
  Lower runs first. Ties are broken by registration order, so it is total.
  */
  readonly priority: number;
}

export type ProviderSelection =
  | { readonly selected: true; readonly provider: PixPaymentProvider }
  | { readonly selected: false; readonly reason: string };

export class ProviderRegistry {
  private readonly registered: RegisteredProvider[] = [];

  public constructor(providers: readonly RegisteredProvider[] = []) {
    this.registered = [...providers];
  }

  /**
   * Every provider that could serve this payment, best first.
   *
   * Returned as a list rather than a single choice because failover consumes it:
   * an attempt that ends in a safe failure moves to the next entry, and one that
   * ends unknown may not move at all.
   */
  public candidatesForPix(
    method: PaymentMethod,
    currency: string,
    environment: 'SANDBOX' | 'PRODUCTION',
  ): PixPaymentProvider[] {
    return this.registered
      .filter((entry) => entry.pix !== undefined)
      .filter((entry) => entry.environment === environment)
      .filter((entry) => canServeMethod(entry.descriptor, method, currency))
      .toSorted((left, right) => left.priority - right.priority)
      .map((entry) => entry.pix)
      .filter((provider): provider is PixPaymentProvider => provider !== undefined);
  }

  /**
   * The provider that can be asked about a payment it already handled.
   *
   * Looked up by code rather than routed to, because reconciliation must ask the
   * provider that was actually used and no other. Reading state is a declared
   * capability: a provider that cannot answer questions about a payment is
   * reported as such rather than being called and made to refuse, which would turn
   * a routing fact into a runtime failure.
   */
  public selectForPixStatus(
    providerCode: string,
    environment: 'SANDBOX' | 'PRODUCTION',
  ): ProviderSelection {
    const entry = this.registered.find(
      (candidate) =>
        candidate.descriptor.code === providerCode && candidate.environment === environment,
    );

    if (entry?.pix === undefined) {
      return {
        selected: false,
        reason: `No ${providerCode} provider is configured for ${environment}, so its payments cannot be inquired about.`,
      };
    }
    if (!hasCapability(entry.descriptor, 'pix.status')) {
      return {
        selected: false,
        reason: `${providerCode} does not declare pix.status, so it cannot be asked about a payment it created.`,
      };
    }
    return { selected: true, provider: entry.pix };
  }

  public selectForPix(
    method: PaymentMethod,
    currency: string,
    environment: 'SANDBOX' | 'PRODUCTION',
  ): ProviderSelection {
    const candidates = this.candidatesForPix(method, currency, environment);
    const first = candidates[0];

    if (first === undefined) {
      // Reported rather than thrown: no configured provider is an ordinary
      // routing outcome that the payment records as a failure, not a crash.
      return {
        selected: false,
        reason: `No configured provider can serve ${method} in ${currency} for ${environment}.`,
      };
    }
    return { selected: true, provider: first };
  }
}
