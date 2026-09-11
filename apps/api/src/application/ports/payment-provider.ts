import type { ProviderDescriptor } from '../../domain/provider/provider-capability.js';
import type { ProviderOutcomeClass } from '../../domain/provider/provider-outcome.js';

/**
 * What the gateway asks a provider to do, in the gateway's own vocabulary.
 *
 * Nothing here names Appmax, an order, a customer id, or any other processor's
 * concept. An adapter translates in both directions, so replacing a provider — or
 * adding a card one, or a crypto one — changes an adapter and nothing above it.
 */

interface ProviderCustomer {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string;
  /**
   * CPF or CNPJ. Required by the Pix rails, not by us.
   */
  readonly documentNumber: string;
  readonly ipAddress: string;
}

export interface CreatePixInstrumentRequest {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly description: string;
  /**
   * Our own reference, for whatever correlation the provider happens to support.
   */
  readonly reference: string;
  readonly customer: ProviderCustomer;
}

/**
 * A payable Pix code. Deliberately not "an Appmax order with a pix object on it".
 */
export interface PixInstrument {
  readonly copyAndPasteCode: string;
  readonly qrCodeImageDataUri: string | undefined;
  readonly expiresAt: Date | undefined;
}

export interface CreateCryptoInstrumentRequest {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly description: string;
  /**
   * Our payment's public identifier. Unique forever, unlike a merchant reference,
   * which is free again once an earlier payment for it has finished, so it is
   * what the provider is asked to correlate on.
   */
  readonly paymentId: string;
  readonly merchantReference: string;
  /**
   * Which of the provider's declared networks to issue on. Absent, the provider
   * uses the one it was registered for.
   */
  readonly network: string | undefined;
  /**
   * The key the provider deduplicates on. A retried creation after a timeout
   * must be given the same one, or the customer is handed two destinations for
   * one order.
   */
  readonly idempotencyKey: string;
}

/**
 * A crypto payment destination the customer can pay, in ledger vocabulary.
 *
 * Nothing here names a chain id, a contract or a URI scheme: the provider chose
 * the network for us and rendered the URI and the QR code for it. The gateway
 * presents them and never has to know how they were built.
 */
export interface CryptoInstrument {
  readonly network: string;
  readonly asset: string;
  readonly destinationAddress: string;
  readonly paymentUri: string;
  readonly qrCodeImageDataUri: string;
  /**
   * What the provider will accept, in our minor units, so the gateway can refuse
   * a destination that asks the customer for a different amount than the merchant
   * requested.
   */
  readonly amountMinor: bigint;
  readonly expiresAt: Date | undefined;
}

/**
 * What the gateway believes about a payment after reading provider state.
 *
 * Expressed as a small closed vocabulary rather than the provider's own status
 * strings, so the state machine never learns a processor's words. `unknown` is a
 * real answer here: a provider may report something nobody has mapped, and
 * guessing is how a payment silently ends up in the wrong state.
 */
export type ObservedLifecycle =
  | 'awaiting_payment'
  | 'paid'
  | 'expired'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'chargeback'
  | 'unknown';

export interface ObservedPaymentState {
  readonly lifecycle: ObservedLifecycle;
  readonly capturedAmountMinor: bigint;
  readonly paidAt: Date | undefined;
  /**
   * The provider's own status string, kept only for the audit trail.
   */
  readonly rawStatus: string;
}

export type ProviderResult<Value> =
  | {
      readonly outcome: 'success';
      readonly value: Value;
      /**
       * The provider's identifier for whatever this call created or read.
       */
      readonly providerReference: string;
    }
  | {
      readonly outcome: Exclude<ProviderOutcomeClass, 'success'>;
      readonly reason: string;
      /**
       * Present when the provider got far enough to name something, even though
       * the call did not succeed. An unknown outcome that carries a reference is
       * far cheaper to reconcile than one that does not.
       */
      readonly providerReference?: string;
    };

/**
 * A provider that can issue Pix instruments.
 *
 * Small on purpose. A provider that also does cards implements a second, separate
 * interface; it does not inherit a wider one full of methods it must refuse.
 */
export interface PixPaymentProvider {
  readonly descriptor: ProviderDescriptor;

  createPixInstrument(request: CreatePixInstrumentRequest): Promise<ProviderResult<PixInstrument>>;

  /**
   * Reads authoritative provider state.
   *
   * This is the only thing permitted to fund a payment. A webhook may prompt a
   * call to it, and may never substitute for one.
   */
  readPaymentState(providerReference: string): Promise<ProviderResult<ObservedPaymentState>>;
}

/**
 * A provider that can issue crypto payment destinations.
 *
 * Reading state has the same shape as for Pix on purpose: reconciliation and the
 * webhook path are provider-agnostic, and the same authenticated read is the
 * only thing permitted to fund a crypto payment.
 */
export interface CryptoPaymentProvider {
  readonly descriptor: ProviderDescriptor;

  createCryptoInstrument(
    request: CreateCryptoInstrumentRequest,
  ): Promise<ProviderResult<CryptoInstrument>>;

  readPaymentState(providerReference: string): Promise<ProviderResult<ObservedPaymentState>>;
}

/**
 * The part of any provider reconciliation talks to. Which kind of instrument a
 * provider issued is irrelevant to asking it what became of one.
 */
export type PaymentStateReader = Pick<PixPaymentProvider, 'readPaymentState'>;

export interface RefundCapableProvider {
  readonly descriptor: ProviderDescriptor;
  refundInFull(providerReference: string): Promise<ProviderResult<ObservedPaymentState>>;
}
