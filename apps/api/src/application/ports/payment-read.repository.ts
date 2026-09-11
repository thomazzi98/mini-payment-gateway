import type { PresentedInstrument } from '../create-payment.use-case.js';

/**
 * What reading a payment back needs from storage: the payment, the attempt that
 * issued its instrument, and the three histories a merchant can act on — how the
 * status moved, what the provider said, and what became of the paid event.
 */

interface PaymentTransitionRecord {
  readonly sequence: number;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly trigger: string;
  readonly evidenceClass: string;
  readonly reason: string | undefined;
  readonly occurredAt: Date;
}

interface ProviderNotificationRecord {
  readonly provider: string;
  readonly eventType: string;
  readonly receivedAt: Date;
  readonly disposition: string;
}

interface PaymentEventRecord {
  readonly type: string;
  readonly occurredAt: Date;
  readonly deliveryStatus: string;
  readonly deliveryReference: string | undefined;
  readonly attempts: number;
  readonly publishedAt: Date | undefined;
  readonly lastFailure: string | undefined;
}

export interface PaymentSnapshot {
  readonly publicId: string;
  readonly status: string;
  readonly paymentMethod: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly currency: string;
  readonly expectedAmountMinor: bigint;
  readonly capturedAmountMinor: bigint;
  readonly merchantReference: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date | undefined;
  readonly paidAt: Date | undefined;
  readonly providerCode: string | undefined;
  readonly providerReference: string | undefined;
  readonly instrument: PresentedInstrument | undefined;
  readonly transitions: readonly PaymentTransitionRecord[];
  readonly providerNotifications: readonly ProviderNotificationRecord[];
  readonly events: readonly PaymentEventRecord[];
}

export interface PaymentReadStore {
  /**
   * Scoped by organization and environment in the query, so another tenant's
   * payment and a payment that does not exist are the same answer.
   */
  findByPublicId(query: {
    readonly organizationId: string;
    readonly environment: 'SANDBOX' | 'PRODUCTION';
    readonly publicId: string;
  }): Promise<PaymentSnapshot | undefined>;
}
