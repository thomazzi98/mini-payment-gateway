/**
 * The payment lifecycle, as data.
 *
 * This table is the single source of truth. The state machine reads it, the
 * generated documentation is derived from it, and the database enforces it
 * through a foreign key into a table seeded from the same list. Adding an edge is
 * one entry here, not four changes that have to agree.
 *
 * A payment is deliberately independent of any provider. It may be attempted
 * against several providers, and one payment is never assumed to equal one
 * provider transaction.
 */

export const PAYMENT_STATUSES = [
  'pending',
  'processing',
  'unknown',
  'awaiting_payment',
  'paid',
  'partially_refunded',
  'refunded',
  'chargeback',
  'expired',
  'failed',
  'cancelled',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Statuses from which nothing further can happen.
 *
 * `expired` is deliberately NOT terminal. A Pix code can be paid moments after it
 * lapses, and the money genuinely arrives; refusing to record that would be
 * pretending a real payment did not happen.
 */
export const TERMINAL_PAYMENT_STATUSES = ['refunded', 'failed', 'cancelled'] as const;

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return (TERMINAL_PAYMENT_STATUSES as readonly PaymentStatus[]).includes(status);
}

/**
 * Statuses in which the customer's money is known to be held by the gateway.
 */
export const FUNDED_PAYMENT_STATUSES = [
  'paid',
  'partially_refunded',
  'refunded',
  'chargeback',
] as const;

export function isFundedPaymentStatus(status: PaymentStatus): boolean {
  return (FUNDED_PAYMENT_STATUSES as readonly PaymentStatus[]).includes(status);
}

export const PAYMENT_TRIGGERS = [
  'PROVIDER_REQUEST_SENT',
  'INSTRUMENT_ISSUED',
  'PROVIDER_REFUSED',
  'PROVIDER_OUTCOME_UNKNOWN',
  'ROUTING_EXHAUSTED',
  'SAFE_FAILURE_OBSERVED',
  'RECONCILED_INSTRUMENT_LIVE',
  'RECONCILED_NOT_CREATED',
  'RECONCILED_PAID',
  'RECONCILED_EXPIRED',
  'RESOLUTION_EXHAUSTED',
  'PAYMENT_CONFIRMED',
  'LATE_PAYMENT_CONFIRMED',
  'EXPIRY_ELAPSED',
  'MERCHANT_CANCELLED',
  'REFUND_SETTLED',
  'PARTIAL_REFUND_SETTLED',
  'CHARGEBACK_OPENED',
  'CHARGEBACK_WON',
  'CHARGEBACK_LOST',
] as const;

export type PaymentTrigger = (typeof PAYMENT_TRIGGERS)[number];

/**
 * How much confidence a transition demands.
 *
 * `authenticated_provider_read` exists because Appmax webhooks carry no signature
 * of any kind. A webhook may therefore never move money on its own; it schedules a
 * read, and only the read's evidence can fund a payment.
 */
export const EVIDENCE_CLASSES = ['internal', 'authenticated_provider_read', 'operator'] as const;

export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export interface PaymentTransition {
  readonly from: PaymentStatus;
  readonly to: PaymentStatus;
  readonly trigger: PaymentTrigger;
  readonly minimumEvidence: EvidenceClass;
  readonly description: string;
}

export const PAYMENT_TRANSITIONS: readonly PaymentTransition[] = [
  {
    from: 'pending',
    to: 'processing',
    trigger: 'PROVIDER_REQUEST_SENT',
    minimumEvidence: 'internal',
    description: 'A provider has been selected and the request is in flight.',
  },
  {
    from: 'pending',
    to: 'cancelled',
    trigger: 'MERCHANT_CANCELLED',
    minimumEvidence: 'internal',
    description: 'The merchant withdrew the payment before any provider was contacted.',
  },
  {
    from: 'pending',
    to: 'failed',
    trigger: 'ROUTING_EXHAUSTED',
    minimumEvidence: 'internal',
    description: 'No configured provider can serve this payment.',
  },

  {
    from: 'processing',
    to: 'awaiting_payment',
    trigger: 'INSTRUMENT_ISSUED',
    minimumEvidence: 'authenticated_provider_read',
    description: 'The provider returned a payable instrument and the customer may now pay.',
  },
  {
    from: 'processing',
    to: 'failed',
    trigger: 'PROVIDER_REFUSED',
    minimumEvidence: 'authenticated_provider_read',
    description: 'The provider refused the payment outright and created nothing.',
  },
  {
    from: 'processing',
    to: 'unknown',
    trigger: 'PROVIDER_OUTCOME_UNKNOWN',
    minimumEvidence: 'internal',
    description:
      'The provider call did not produce a usable answer. Whether anything was created is unknown, so no failover is permitted until it is resolved.',
  },
  {
    from: 'processing',
    to: 'pending',
    trigger: 'SAFE_FAILURE_OBSERVED',
    minimumEvidence: 'authenticated_provider_read',
    description: 'The provider confirmed it created nothing, so another provider may be attempted.',
  },

  {
    from: 'unknown',
    to: 'awaiting_payment',
    trigger: 'RECONCILED_INSTRUMENT_LIVE',
    minimumEvidence: 'authenticated_provider_read',
    description: 'Reconciliation found a live instrument from the uncertain attempt.',
  },
  {
    from: 'unknown',
    to: 'pending',
    trigger: 'RECONCILED_NOT_CREATED',
    minimumEvidence: 'authenticated_provider_read',
    description:
      'Reconciliation proved nothing was created, which is the only condition under which failover is safe.',
  },
  {
    from: 'unknown',
    to: 'paid',
    trigger: 'RECONCILED_PAID',
    minimumEvidence: 'authenticated_provider_read',
    description: 'Reconciliation found the uncertain attempt had in fact been paid.',
  },
  {
    from: 'unknown',
    to: 'expired',
    trigger: 'RECONCILED_EXPIRED',
    minimumEvidence: 'authenticated_provider_read',
    description: 'Reconciliation found the uncertain instrument had lapsed unpaid.',
  },
  {
    from: 'unknown',
    to: 'failed',
    trigger: 'RESOLUTION_EXHAUSTED',
    minimumEvidence: 'operator',
    description:
      'The uncertainty could not be resolved within its window and an operator closed it.',
  },

  {
    from: 'awaiting_payment',
    to: 'paid',
    trigger: 'PAYMENT_CONFIRMED',
    minimumEvidence: 'authenticated_provider_read',
    description: 'The provider confirmed, on an authenticated read, that the customer paid.',
  },
  {
    from: 'awaiting_payment',
    to: 'expired',
    trigger: 'EXPIRY_ELAPSED',
    minimumEvidence: 'authenticated_provider_read',
    description: 'The instrument lapsed without payment.',
  },
  {
    from: 'awaiting_payment',
    to: 'cancelled',
    trigger: 'MERCHANT_CANCELLED',
    minimumEvidence: 'internal',
    description: 'The merchant withdrew the payment while it was still unpaid.',
  },
  {
    from: 'awaiting_payment',
    to: 'unknown',
    trigger: 'PROVIDER_OUTCOME_UNKNOWN',
    minimumEvidence: 'internal',
    description: 'The provider stopped answering, so the instrument state is no longer known.',
  },

  {
    from: 'expired',
    to: 'paid',
    trigger: 'LATE_PAYMENT_CONFIRMED',
    minimumEvidence: 'authenticated_provider_read',
    description:
      'The customer paid after the instrument lapsed. The money arrived, so it is recorded rather than denied.',
  },

  {
    from: 'paid',
    to: 'partially_refunded',
    trigger: 'PARTIAL_REFUND_SETTLED',
    minimumEvidence: 'authenticated_provider_read',
    description: 'Part of the captured amount was returned.',
  },
  {
    from: 'paid',
    to: 'refunded',
    trigger: 'REFUND_SETTLED',
    minimumEvidence: 'authenticated_provider_read',
    description: 'The whole captured amount was returned.',
  },
  {
    from: 'paid',
    to: 'chargeback',
    trigger: 'CHARGEBACK_OPENED',
    minimumEvidence: 'authenticated_provider_read',
    description: 'The issuing bank reversed the payment and a dispute is open.',
  },

  {
    from: 'partially_refunded',
    to: 'refunded',
    trigger: 'REFUND_SETTLED',
    minimumEvidence: 'authenticated_provider_read',
    description: 'The remainder was returned, so nothing is left captured.',
  },
  {
    from: 'partially_refunded',
    to: 'chargeback',
    trigger: 'CHARGEBACK_OPENED',
    minimumEvidence: 'authenticated_provider_read',
    description: 'A dispute was opened over what remains captured.',
  },

  {
    from: 'chargeback',
    to: 'paid',
    trigger: 'CHARGEBACK_WON',
    minimumEvidence: 'authenticated_provider_read',
    description: 'The dispute was resolved in the merchant’s favour.',
  },
  {
    from: 'chargeback',
    to: 'refunded',
    trigger: 'CHARGEBACK_LOST',
    minimumEvidence: 'authenticated_provider_read',
    description: 'The dispute was lost and the money returned to the customer.',
  },
];
