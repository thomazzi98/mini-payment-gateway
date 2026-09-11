import type { PresentedInstrument } from './create-payment.use-case.js';
import type { PaymentReadStore, PaymentSnapshot } from './ports/payment-read.repository.js';

/**
 * Reading a payment back.
 *
 * The answer is the gateway's own record and nothing else: no provider is asked.
 * What a merchant sees here is what the database can prove — the current status,
 * the transition that put it there and the evidence it demanded, what the
 * provider notified, and whether the paid event has been handed on.
 */

export interface PaymentDetail {
  readonly id: string;
  readonly status: string;
  readonly paymentMethod: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly amountMinor: string;
  readonly capturedAmountMinor: string;
  readonly currency: string;
  readonly merchantReference: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly paidAt?: string;
  readonly provider?: string;
  readonly providerReference?: string;
  readonly instrument?: PresentedInstrument;
  readonly transitions: readonly {
    readonly sequence: number;
    readonly fromStatus: string;
    readonly toStatus: string;
    readonly trigger: string;
    readonly evidenceClass: string;
    readonly reason?: string;
    readonly occurredAt: string;
  }[];
  readonly providerNotifications: readonly {
    readonly provider: string;
    readonly eventType: string;
    readonly receivedAt: string;
    readonly disposition: string;
  }[];
  readonly events: readonly {
    readonly type: string;
    readonly occurredAt: string;
    readonly delivery: {
      readonly channel: 'whatsapp';
      readonly status: string;
      readonly attempts: number;
      readonly reference?: string;
      readonly publishedAt?: string;
      readonly lastFailure?: string;
    };
  }[];
}

export type ReadPaymentOutcome =
  { readonly kind: 'found'; readonly payment: PaymentDetail } | { readonly kind: 'not_found' };

export interface ReadPaymentDependencies {
  readonly store: PaymentReadStore;
}

export async function readPayment(
  query: {
    readonly organizationId: string;
    readonly environment: 'SANDBOX' | 'PRODUCTION';
    readonly publicId: string;
  },
  dependencies: ReadPaymentDependencies,
): Promise<ReadPaymentOutcome> {
  const snapshot = await dependencies.store.findByPublicId(query);
  if (snapshot === undefined) {
    return { kind: 'not_found' };
  }
  return { kind: 'found', payment: present(snapshot) };
}

function present(snapshot: PaymentSnapshot): PaymentDetail {
  return {
    id: snapshot.publicId,
    status: snapshot.status,
    paymentMethod: snapshot.paymentMethod,
    environment: snapshot.environment,
    amountMinor: snapshot.expectedAmountMinor.toString(),
    capturedAmountMinor: snapshot.capturedAmountMinor.toString(),
    currency: snapshot.currency,
    merchantReference: snapshot.merchantReference,
    createdAt: snapshot.createdAt.toISOString(),
    updatedAt: snapshot.updatedAt.toISOString(),
    ...(snapshot.expiresAt !== undefined && { expiresAt: snapshot.expiresAt.toISOString() }),
    ...(snapshot.paidAt !== undefined && { paidAt: snapshot.paidAt.toISOString() }),
    ...(snapshot.providerCode !== undefined && { provider: snapshot.providerCode }),
    ...(snapshot.providerReference !== undefined && {
      providerReference: snapshot.providerReference,
    }),
    ...(snapshot.instrument !== undefined && { instrument: snapshot.instrument }),
    transitions: snapshot.transitions.map((transition) => ({
      sequence: transition.sequence,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      trigger: transition.trigger,
      evidenceClass: transition.evidenceClass,
      ...(transition.reason !== undefined && { reason: transition.reason }),
      occurredAt: transition.occurredAt.toISOString(),
    })),
    providerNotifications: snapshot.providerNotifications.map((notification) => ({
      provider: notification.provider,
      eventType: notification.eventType,
      receivedAt: notification.receivedAt.toISOString(),
      disposition: notification.disposition,
    })),
    events: snapshot.events.map((event) => ({
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
      delivery: {
        channel: 'whatsapp',
        status: event.deliveryStatus,
        attempts: event.attempts,
        ...(event.deliveryReference !== undefined && { reference: event.deliveryReference }),
        ...(event.publishedAt !== undefined && { publishedAt: event.publishedAt.toISOString() }),
        ...(event.lastFailure !== undefined && { lastFailure: event.lastFailure }),
      },
    })),
  };
}
