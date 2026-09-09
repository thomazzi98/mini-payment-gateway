import { canServeMethod } from '../domain/provider/provider-capability.js';
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
  public candidatesForPix(method: PaymentMethod, currency: string): PixPaymentProvider[] {
    return this.registered
      .filter((entry) => entry.pix !== undefined)
      .filter((entry) => canServeMethod(entry.descriptor, method, currency))
      .toSorted((left, right) => left.priority - right.priority)
      .map((entry) => entry.pix)
      .filter((provider): provider is PixPaymentProvider => provider !== undefined);
  }

  public selectForPix(method: PaymentMethod, currency: string): ProviderSelection {
    const candidates = this.candidatesForPix(method, currency);
    const first = candidates[0];

    if (first === undefined) {
      // Reported rather than thrown: no configured provider is an ordinary
      // routing outcome that the payment records as a failure, not a crash.
      return {
        selected: false,
        reason: `No configured provider can serve ${method} in ${currency}.`,
      };
    }
    return { selected: true, provider: first };
  }
}
