/**
 * What a provider can actually do.
 *
 * Capabilities are declared, not assumed. There is no universal provider
 * interface carrying every method every processor might one day support, because
 * that shape forces each adapter to implement methods it cannot honour and then
 * throw — which turns "this provider does not do refunds" into a runtime surprise
 * instead of a routing decision.
 *
 * A provider that does not declare a capability is never asked to perform it.
 */

export const PROVIDER_CAPABILITIES = [
  'pix.create',
  'pix.status',
  'crypto.create',
  'crypto.status',
  'card.create',
  'card.tokenize',
  'boleto.create',
  'refund.full',
  'refund.partial',
  'order.read',
  'webhook.receive',
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export function isProviderCapability(candidate: unknown): candidate is ProviderCapability {
  return (
    typeof candidate === 'string' && PROVIDER_CAPABILITIES.includes(candidate as ProviderCapability)
  );
}

export const PAYMENT_METHODS = ['pix', 'crypto', 'card', 'boleto'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * The capability a payment method needs before a provider can be routed to it.
 */
const METHOD_REQUIREMENTS: Readonly<Record<PaymentMethod, ProviderCapability>> = {
  pix: 'pix.create',
  crypto: 'crypto.create',
  card: 'card.create',
  boleto: 'boleto.create',
};

export function capabilityForMethod(method: PaymentMethod): ProviderCapability {
  return METHOD_REQUIREMENTS[method];
}

export interface ProviderDescriptor {
  readonly code: string;
  readonly displayName: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly supportedCurrencies: readonly string[];
  /**
   * The networks a crypto provider can issue destinations on, as the provider
   * names them. Absent on rails that have no notion of a network.
   */
  readonly supportedNetworks?: readonly string[];
  /**
   * Whether creating a payment instrument can be retried safely after an
   * uncertain outcome. Appmax cannot: order creation carries no idempotency key
   * and no external reference, so a retry may create a second order.
   */
  readonly instrumentCreationIsIdempotent: boolean;
}

export function hasCapability(
  descriptor: ProviderDescriptor,
  capability: ProviderCapability,
): boolean {
  return descriptor.capabilities.includes(capability);
}

export function canServeMethod(
  descriptor: ProviderDescriptor,
  method: PaymentMethod,
  currency: string,
  network?: string,
): boolean {
  if (network !== undefined && !(descriptor.supportedNetworks ?? []).includes(network)) {
    return false;
  }
  return (
    hasCapability(descriptor, capabilityForMethod(method)) &&
    descriptor.supportedCurrencies.includes(currency)
  );
}

export class CapabilityNotImplementedError extends Error {
  public constructor(providerCode: string, capability: ProviderCapability) {
    super(
      `Provider ${providerCode} declares ${capability} but does not implement it. A declared capability that is missing would fail at payment time instead of at startup.`,
    );
    this.name = 'CapabilityNotImplementedError';
  }
}

/**
 * Checked once at startup rather than discovered during a payment.
 *
 * A descriptor that claims a capability the adapter does not provide is a
 * configuration error, and the cheapest moment to find it is before the process
 * accepts its first request.
 */
export function assertCapabilitiesAreImplemented(
  descriptor: ProviderDescriptor,
  implemented: ReadonlySet<ProviderCapability>,
): void {
  for (const capability of descriptor.capabilities) {
    if (!implemented.has(capability)) {
      throw new CapabilityNotImplementedError(descriptor.code, capability);
    }
  }
}
