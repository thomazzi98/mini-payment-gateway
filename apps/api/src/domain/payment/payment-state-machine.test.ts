import { describe, expect, it } from 'vitest';
import { decideTransition, isTransitionPermitted, reachableFrom } from './payment-state-machine.js';
import {
  FUNDED_PAYMENT_STATUSES,
  isFundedPaymentStatus,
  isTerminalPaymentStatus,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  PAYMENT_TRIGGERS,
  TERMINAL_PAYMENT_STATUSES,
} from './payment-transition-table.js';
import type { EvidenceClass, PaymentStatus, PaymentTrigger } from './payment-transition-table.js';

const OPERATOR: EvidenceClass = 'operator';

function byName(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

/**
Every (status, trigger) pair, so the suite enumerates rather than samples.
*/
function statusesReachableFromPending(): PaymentStatus[] {
  const seen = new Set<PaymentStatus>(['pending']);
  const queue: PaymentStatus[] = ['pending'];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const unseen = reachableFrom(current).filter((candidate) => !seen.has(candidate));
    for (const next of unseen) {
      seen.add(next);
      queue.push(next);
    }
  }

  return [...seen];
}

function everyStatusAndTrigger(): { from: PaymentStatus; trigger: PaymentTrigger }[] {
  return PAYMENT_STATUSES.flatMap((from) => PAYMENT_TRIGGERS.map((trigger) => ({ from, trigger })));
}

function refusalReasonOf(decision: ReturnType<typeof decideTransition>): string {
  if (decision.permitted) {
    throw new Error(`expected a refusal but the transition was permitted to ${decision.to}`);
  }
  return decision.refusal.reason;
}

function refusalOf(decision: ReturnType<typeof decideTransition>) {
  if (decision.permitted) {
    throw new Error(`expected a refusal but the transition was permitted to ${decision.to}`);
  }
  return decision.refusal;
}

describe('the transition table itself', () => {
  it('declares no duplicate edge for the same status and trigger', () => {
    // Two rows for one (status, trigger) would make the outcome depend on
    // iteration order, which is not a thing a payment system may depend on.
    const keys = PAYMENT_TRANSITIONS.map(
      (transition) => `${transition.from}:${transition.trigger}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never leaves a terminal status', () => {
    const leavingTerminal = PAYMENT_TRANSITIONS.filter((transition) =>
      isTerminalPaymentStatus(transition.from),
    );
    expect(leavingTerminal).toEqual([]);
  });

  it('uses only declared statuses and triggers', () => {
    for (const transition of PAYMENT_TRANSITIONS) {
      expect(PAYMENT_STATUSES).toContain(transition.from);
      expect(PAYMENT_STATUSES).toContain(transition.to);
      expect(PAYMENT_TRIGGERS).toContain(transition.trigger);
    }
  });

  it('never transitions a status to itself', () => {
    expect(PAYMENT_TRANSITIONS.filter((transition) => transition.from === transition.to)).toEqual(
      [],
    );
  });

  it('gives every non-terminal status somewhere to go', () => {
    const nonTerminal = PAYMENT_STATUSES.filter((each) => !isTerminalPaymentStatus(each));
    for (const status of nonTerminal) {
      expect(reachableFrom(status).length, `${status} is a dead end`).toBeGreaterThan(0);
    }
  });

  it('makes every status reachable from pending, so none is orphaned', () => {
    const reached = statusesReachableFromPending();
    expect(reached.toSorted(byName)).toEqual([...PAYMENT_STATUSES].toSorted(byName));
  });

  it('requires an authenticated provider read for every transition into a funded status', () => {
    // The rule that makes an unauthenticated webhook harmless: it may schedule a
    // read, but it can never itself fund a payment.
    const intoFunded = PAYMENT_TRANSITIONS.filter((each) => isFundedPaymentStatus(each.to));
    for (const transition of intoFunded) {
      expect(
        transition.minimumEvidence,
        `${transition.from} -> ${transition.to} must demand an authenticated read`,
      ).toBe('authenticated_provider_read');
    }
  });

  it('pins which statuses mean the gateway is holding money', () => {
    expect([...FUNDED_PAYMENT_STATUSES]).toEqual([
      'paid',
      'partially_refunded',
      'refunded',
      'chargeback',
    ]);
  });

  it('describes every edge, because a table nobody can read is not a source of truth', () => {
    for (const transition of PAYMENT_TRANSITIONS) {
      expect(transition.description.length).toBeGreaterThan(20);
    }
  });
});

describe('the full cartesian product of statuses and triggers', () => {
  it('permits exactly the declared edges and refuses every other combination', () => {
    // Enumerated rather than sampled. The interesting cases are the ones nobody
    // thought to write a test for.
    const declared = new Set(
      PAYMENT_TRANSITIONS.map((transition) => `${transition.from}:${transition.trigger}`),
    );

    const combinations = everyStatusAndTrigger();
    const permitted: string[] = [];

    for (const { from, trigger } of combinations) {
      const decision = decideTransition({ from, trigger, evidence: OPERATOR });
      const shouldBePermitted = declared.has(`${from}:${trigger}`);

      expect(decision.permitted, `${from} --${trigger}-->`).toBe(shouldBePermitted);
      if (decision.permitted) {
        permitted.push(`${from}:${trigger}`);
      }
    }

    const permittedCount = permitted.length;
    const refusedCount = combinations.length - permittedCount;

    expect(permittedCount).toBe(PAYMENT_TRANSITIONS.length);
    expect(permittedCount + refusedCount).toBe(PAYMENT_STATUSES.length * PAYMENT_TRIGGERS.length);
  });

  it('refuses every trigger from every terminal status', () => {
    const fromTerminal = everyStatusAndTrigger().filter((pair) =>
      (TERMINAL_PAYMENT_STATUSES as readonly PaymentStatus[]).includes(pair.from),
    );

    for (const { from, trigger } of fromTerminal) {
      const decision = decideTransition({ from, trigger, evidence: OPERATOR });
      expect(refusalReasonOf(decision)).toBe('terminal_status');
    }
  });
});

describe('specific edges that money depends on', () => {
  it('never moves a paid payment back to awaiting payment or pending', () => {
    for (const trigger of PAYMENT_TRIGGERS) {
      const decision = decideTransition({ from: 'paid', trigger, evidence: OPERATOR });
      const destination = decision.permitted ? decision.to : undefined;
      expect(['awaiting_payment', 'pending', 'processing']).not.toContain(destination);
    }
  });

  it('does not expire a payment that is already paid', () => {
    expect(
      isTransitionPermitted({ from: 'paid', trigger: 'EXPIRY_ELAPSED', evidence: OPERATOR }),
    ).toBe(false);
  });

  it('allows a late payment to be recorded after expiry', () => {
    // The customer really did pay. Denying it would be losing their money.
    const decision = decideTransition({
      from: 'expired',
      trigger: 'LATE_PAYMENT_CONFIRMED',
      evidence: 'authenticated_provider_read',
    });
    expect(decision.permitted && decision.to).toBe('paid');
  });

  it('permits failover only once the provider has confirmed nothing was created', () => {
    // From unknown, the ONLY route back to pending — the state in which another
    // provider may be attempted — is proof that nothing exists to be paid twice.
    const routesBackToPending = PAYMENT_TRIGGERS.filter((trigger) => {
      const decision = decideTransition({
        from: 'unknown',
        trigger,
        evidence: 'authenticated_provider_read',
      });
      return decision.permitted && decision.to === 'pending';
    });

    expect(routesBackToPending).toEqual(['RECONCILED_NOT_CREATED']);
  });

  it('refuses to leave unknown on internal evidence alone', () => {
    for (const trigger of PAYMENT_TRIGGERS) {
      const decision = decideTransition({ from: 'unknown', trigger, evidence: 'internal' });
      expect(decision.permitted, `unknown --${trigger}--> on internal evidence`).toBe(false);
    }
  });
});

describe('evidence', () => {
  it('refuses a funding transition supported only by internal evidence', () => {
    const decision = decideTransition({
      from: 'awaiting_payment',
      trigger: 'PAYMENT_CONFIRMED',
      evidence: 'internal',
    });

    expect(refusalOf(decision)).toEqual({
      reason: 'insufficient_evidence',
      required: 'authenticated_provider_read',
      supplied: 'internal',
    });
  });

  it('accepts stronger evidence than required', () => {
    expect(
      isTransitionPermitted({
        from: 'awaiting_payment',
        trigger: 'PAYMENT_CONFIRMED',
        evidence: 'operator',
      }),
    ).toBe(true);
  });

  it('accepts internal evidence where only internal is required', () => {
    expect(
      isTransitionPermitted({
        from: 'pending',
        trigger: 'PROVIDER_REQUEST_SENT',
        evidence: 'internal',
      }),
    ).toBe(true);
  });

  it('reports why it refused, so an operator can act on it', () => {
    const unknownEdge = decideTransition({
      from: 'pending',
      trigger: 'PAYMENT_CONFIRMED',
      evidence: OPERATOR,
    });
    expect(refusalReasonOf(unknownEdge)).toBe('no_such_transition');
  });
});
