import {
  EVIDENCE_CLASSES,
  isTerminalPaymentStatus,
  PAYMENT_TRANSITIONS,
} from './payment-transition-table.js';
import type {
  EvidenceClass,
  PaymentStatus,
  PaymentTransition,
  PaymentTrigger,
} from './payment-transition-table.js';

export interface TransitionRequest {
  readonly from: PaymentStatus;
  readonly trigger: PaymentTrigger;
  readonly evidence: EvidenceClass;
}

type TransitionRefusal =
  | { readonly reason: 'terminal_status'; readonly from: PaymentStatus }
  | {
      readonly reason: 'no_such_transition';
      readonly from: PaymentStatus;
      readonly trigger: PaymentTrigger;
    }
  | {
      readonly reason: 'insufficient_evidence';
      readonly required: EvidenceClass;
      readonly supplied: EvidenceClass;
    };

export type TransitionDecision =
  | { readonly permitted: true; readonly to: PaymentStatus; readonly transition: PaymentTransition }
  | { readonly permitted: false; readonly refusal: TransitionRefusal };

const TRANSITIONS_BY_KEY = new Map<string, PaymentTransition>(
  PAYMENT_TRANSITIONS.map((transition) => [`${transition.from}:${transition.trigger}`, transition]),
);

/**
 * Evidence is ordered by how much it is trusted. A transition demanding an
 * authenticated read cannot be satisfied by something merely internal, which is
 * what stops an unauthenticated provider webhook from funding a payment.
 */
const EVIDENCE_RANK = new Map<EvidenceClass, number>(
  EVIDENCE_CLASSES.map((evidence, index) => [evidence, index]),
);

function rankOf(evidence: EvidenceClass): number {
  return EVIDENCE_RANK.get(evidence) ?? 0;
}

export function decideTransition(request: TransitionRequest): TransitionDecision {
  // Checked first and without exception. A late event arriving against a finished
  // payment is recorded elsewhere and never applied; resurrecting a terminal
  // payment is the bug class that double-credits a merchant.
  if (isTerminalPaymentStatus(request.from)) {
    return { permitted: false, refusal: { reason: 'terminal_status', from: request.from } };
  }

  const transition = TRANSITIONS_BY_KEY.get(`${request.from}:${request.trigger}`);
  if (transition === undefined) {
    return {
      permitted: false,
      refusal: { reason: 'no_such_transition', from: request.from, trigger: request.trigger },
    };
  }

  if (rankOf(request.evidence) < rankOf(transition.minimumEvidence)) {
    return {
      permitted: false,
      refusal: {
        reason: 'insufficient_evidence',
        required: transition.minimumEvidence,
        supplied: request.evidence,
      },
    };
  }

  return { permitted: true, to: transition.to, transition };
}

export function isTransitionPermitted(request: TransitionRequest): boolean {
  return decideTransition(request).permitted;
}

/**
 * Every status reachable from a given one, regardless of trigger.
 */
export function reachableFrom(status: PaymentStatus): PaymentStatus[] {
  return [
    ...new Set(
      PAYMENT_TRANSITIONS.filter((transition) => transition.from === status).map(
        (transition) => transition.to,
      ),
    ),
  ];
}
