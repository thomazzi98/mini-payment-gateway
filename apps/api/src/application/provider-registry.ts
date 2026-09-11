import { canServeMethod, hasCapability } from '../domain/provider/provider-capability.js';
import type { PaymentMethod, ProviderDescriptor } from '../domain/provider/provider-capability.js';
import type {
  CryptoPaymentProvider,
  PaymentStateReader,
  PixPaymentProvider,
} from './ports/payment-provider.js';

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
  readonly crypto?: CryptoPaymentProvider;
  /**
  Lower runs first. Ties are broken by registration order, so it is total.
  */
  readonly priority: number;
}

export type ProviderSelection =
  | { readonly selected: true; readonly provider: PixPaymentProvider }
  | { readonly selected: false; readonly reason: string };

interface OfferedProvider {
  readonly code: string;
  readonly displayName: string;
  readonly currencies: readonly string[];
  readonly networks: readonly string[];
}

function offeredProvider(entry: RegisteredProvider): OfferedProvider {
  return {
    code: entry.descriptor.code,
    displayName: entry.descriptor.displayName,
    currencies: entry.descriptor.supportedCurrencies,
    networks: entry.descriptor.supportedNetworks ?? [],
  };
}

export interface PaymentOptions {
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly methods: readonly {
    readonly method: PaymentMethod;
    /**
     * Empty when nothing can serve the method here. That is an ordinary answer
     * a caller shows, not an error.
     */
    readonly providers: readonly OfferedProvider[];
  }[];
}

export type StateReaderSelection =
  | { readonly selected: true; readonly provider: PaymentStateReader }
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

  public candidatesForCrypto(
    currency: string,
    environment: 'SANDBOX' | 'PRODUCTION',
    network?: string,
  ): CryptoPaymentProvider[] {
    return this.registered
      .filter((entry) => entry.crypto !== undefined)
      .filter((entry) => entry.environment === environment)
      .filter((entry) => canServeMethod(entry.descriptor, 'crypto', currency, network))
      .toSorted((left, right) => left.priority - right.priority)
      .map((entry) => entry.crypto)
      .filter((provider): provider is CryptoPaymentProvider => provider !== undefined);
  }

  /**
   * What this deployment can serve in one environment, for a caller deciding
   * what to offer before creating anything. Derived from the registrations
   * rather than declared beside them, so it cannot promise a provider that is
   * not there.
   */
  public paymentOptions(environment: 'SANDBOX' | 'PRODUCTION'): PaymentOptions {
    const entries = this.registered
      .filter((entry) => entry.environment === environment)
      .toSorted((left, right) => left.priority - right.priority);
    return {
      environment,
      methods: [
        {
          method: 'crypto',
          providers: entries
            .filter((entry) => entry.crypto !== undefined)
            .filter((entry) => hasCapability(entry.descriptor, 'crypto.create'))
            .map((entry) => offeredProvider(entry)),
        },
        {
          method: 'pix',
          providers: entries
            .filter((entry) => entry.pix !== undefined)
            .filter((entry) => hasCapability(entry.descriptor, 'pix.create'))
            .map((entry) => offeredProvider(entry)),
        },
      ],
    };
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
  public selectForStatus(
    providerCode: string,
    environment: 'SANDBOX' | 'PRODUCTION',
  ): StateReaderSelection {
    const entry = this.registered.find(
      (candidate) =>
        candidate.descriptor.code === providerCode && candidate.environment === environment,
    );

    if (entry === undefined) {
      return {
        selected: false,
        reason: `No ${providerCode} provider is configured for ${environment}, so its payments cannot be inquired about.`,
      };
    }
    if (entry.pix !== undefined && hasCapability(entry.descriptor, 'pix.status')) {
      return { selected: true, provider: entry.pix };
    }
    if (entry.crypto !== undefined && hasCapability(entry.descriptor, 'crypto.status')) {
      return { selected: true, provider: entry.crypto };
    }
    return {
      selected: false,
      reason: `${providerCode} does not declare a status capability, so it cannot be asked about a payment it created.`,
    };
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
