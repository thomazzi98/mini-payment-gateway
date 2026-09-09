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

export interface RefundCapableProvider {
  readonly descriptor: ProviderDescriptor;
  refundInFull(providerReference: string): Promise<ProviderResult<ObservedPaymentState>>;
}
