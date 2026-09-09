import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentCreationRepository } from './payment-creation.repository.js';
import type { CreatePaymentCommand } from './payment-creation.repository.js';
import { PaymentReconciliationRepository } from './payment-reconciliation.repository.js';
import {
  createApplicationPool,
  createOwnerPool,
  publicIdentifierFor,
  seedOrganization,
} from './test-database.js';
import type { SeededOrganization } from './test-database.js';

/**
 * Reconciliation against real PostgreSQL.
 *
 * The properties here cannot be observed against a substituted store: leasing
 * depends on SKIP LOCKED, scheduling depends on a trigger, and recording a
 * payment as paid depends on three columns the schema constrains to agree.
 */

interface Fixture {
  ownerPool: Pool;
  applicationPool: Pool;
  payments: PaymentCreationRepository;
  reconciliation: PaymentReconciliationRepository;
  merchant: SeededOrganization;
  otherMerchant: SeededOrganization;
}

const fixture = {} as Fixture;
const organizationIds: string[] = [];

function commandFor(overrides: Partial<CreatePaymentCommand> = {}): CreatePaymentCommand {
  const reference = `reference-${publicIdentifierFor('r')}`;
  return {
    organizationId: fixture.merchant.id,
    environment: 'SANDBOX',
    merchantReference: reference,
    paymentMethod: 'pix',
    currency: 'BRL',
    expectedAmountMinor: 10_000n,
    idempotencyKey: `key-${publicIdentifierFor('k')}`,
    requestPath: '/v1/payments',
    requestBody: { amount: 10_000, currency: 'BRL', reference },
    ...overrides,
  };
}

/**
 * Drives a payment to `unknown` the way a timed-out provider call does.
 */
async function uncertainPayment(
  options: { withReference?: boolean; organizationId?: string } = {},
): Promise<{ paymentId: string; attemptId: string; providerReference: string | undefined }> {
  const command = commandFor(
    options.organizationId === undefined ? {} : { organizationId: options.organizationId },
  );
  const created = await fixture.payments.createPayment(command);
  if (created.kind !== 'created') {
    throw new Error(`expected a fresh payment, got ${created.kind}`);
  }

  const attemptId = await fixture.payments.openAttempt({
    organizationId: command.organizationId,
    paymentId: created.paymentId,
    attemptNumber: 1,
    providerCode: 'appmax',
  });

  const providerReference =
    options.withReference === false ? undefined : publicIdentifierFor('ref');

  await fixture.payments.applyProviderOutcome({
    organizationId: command.organizationId,
    paymentId: created.paymentId,
    attemptId,
    outcomeClass: 'unknown_outcome',
    providerReference,
    failureReason: 'the provider did not answer within the timeout',
    toStatus: 'unknown',
    trigger: 'PROVIDER_OUTCOME_UNKNOWN',
    evidenceClass: 'internal',
    idempotencyKey: command.idempotencyKey,
    environment: 'SANDBOX',
    completesRequest: true,
    responseStatus: 202,
    responseBody: { id: 'pay_rendered', status: 'unknown' },
  });

  return { paymentId: created.paymentId, attemptId, providerReference };
}

interface PaymentRow {
  readonly status: string;
  readonly captured_amount_minor: string;
  readonly paid_at: Date | null;
  readonly reconciliation_due_at: Date | null;
  readonly reconciliation_attempts: number;
}

async function readPayment(paymentId: string): Promise<PaymentRow> {
  const result = await fixture.ownerPool.query<PaymentRow>(
    `SELECT status, captured_amount_minor, paid_at, reconciliation_due_at,
            reconciliation_attempts
       FROM payments WHERE id = $1`,
    [paymentId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('the payment was not found');
  }
  return row;
}

beforeAll(async () => {
  fixture.ownerPool = createOwnerPool();
  fixture.applicationPool = createApplicationPool();
  fixture.payments = new PaymentCreationRepository(fixture.applicationPool);
  fixture.reconciliation = new PaymentReconciliationRepository(fixture.applicationPool);
  fixture.merchant = await seedOrganization(fixture.ownerPool, 'Reconciliation Merchant');
  fixture.otherMerchant = await seedOrganization(fixture.ownerPool, 'Reconciliation Other');
  organizationIds.push(fixture.merchant.id, fixture.otherMerchant.id);
});

afterAll(async () => {
  // The append-only trigger refuses this, which is the point of it. Test teardown
  // suspends it deliberately rather than the trigger being weakened for everyone.
  await fixture.ownerPool.query(
    'ALTER TABLE payment_status_transitions DISABLE TRIGGER payment_status_transitions_append_only',
  );
  await fixture.ownerPool.query(
    'DELETE FROM payment_status_transitions WHERE organization_id = ANY($1)',
    [organizationIds],
  );
  await fixture.ownerPool.query(
    'ALTER TABLE payment_status_transitions ENABLE TRIGGER payment_status_transitions_append_only',
  );
  await fixture.ownerPool.query('DELETE FROM payment_attempts WHERE organization_id = ANY($1)', [
    organizationIds,
  ]);
  await fixture.ownerPool.query('DELETE FROM idempotency_records WHERE organization_id = ANY($1)', [
    organizationIds,
  ]);
  await fixture.ownerPool.query('DELETE FROM payments WHERE organization_id = ANY($1)', [
    organizationIds,
  ]);
  await fixture.ownerPool.query('DELETE FROM organizations WHERE id = ANY($1)', [organizationIds]);
  await fixture.ownerPool.end();
  await fixture.applicationPool.end();
});

describe('scheduling follows status rather than being remembered', () => {
  it('schedules a payment the moment it becomes uncertain', async () => {
    // Nothing enqueued it. A payment that reaches unknown by any path is
    // discoverable, including one moved by code that knows nothing about
    // reconciliation.
    const { paymentId } = await uncertainPayment();
    const payment = await readPayment(paymentId);

    expect(payment.status).toBe('unknown');
    expect(payment.reconciliation_due_at).not.toBeNull();
    expect(payment.reconciliation_attempts).toBe(0);
  });

  it('schedules a payment that is born uncertain, not only one that becomes so', async () => {
    // Nothing inserts a payment as unknown today. The trigger covers it anyway,
    // because "a payment is always inserted as pending" is exactly the kind of
    // assumption this design exists to stop depending on.
    const inserted = await fixture.ownerPool.query<{ reconciliation_due_at: Date | null }>(
      `INSERT INTO payments
         (public_id, organization_id, environment, merchant_reference, payment_method,
          currency, expected_amount_minor, status)
       VALUES ($1, $2, 'SANDBOX', $3, 'pix', 'BRL', 10000, 'unknown')
       RETURNING reconciliation_due_at`,
      [publicIdentifierFor('pay'), fixture.merchant.id, `reference-${publicIdentifierFor('r')}`],
    );

    expect(inserted.rows[0]?.reconciliation_due_at).not.toBeNull();
  });

  it('unschedules it the moment it stops being uncertain', async () => {
    const { paymentId, attemptId } = await uncertainPayment();

    await fixture.reconciliation.applyResolution({
      paymentId,
      organizationId: fixture.merchant.id,
      attemptId,
      toStatus: 'awaiting_payment',
      trigger: 'RECONCILED_INSTRUMENT_LIVE',
      evidenceClass: 'authenticated_provider_read',
      reason: 'Provider reported pendente.',
    });

    const payment = await readPayment(paymentId);
    expect(payment.status).toBe('awaiting_payment');
    expect(payment.reconciliation_due_at).toBeNull();
  });
});

describe('claiming work', () => {
  it('leases a claimed payment instead of locking it', async () => {
    const { paymentId } = await uncertainPayment();

    const first = await fixture.reconciliation.claimDue(50, 300);
    expect(first.map((payment) => payment.paymentId)).toContain(paymentId);

    // Leased forward, so the next pass does not see it again. Nothing is held:
    // the claiming transaction has already committed.
    const second = await fixture.reconciliation.claimDue(50, 300);
    expect(second.map((payment) => payment.paymentId)).not.toContain(paymentId);

    const payment = await readPayment(paymentId);
    expect(payment.reconciliation_attempts).toBe(1);
  });

  it('hands the payment back once the lease elapses, so a dead worker strands nothing', async () => {
    const { paymentId } = await uncertainPayment();

    // A worker claims it and dies without resolving anything.
    await fixture.reconciliation.claimDue(50, 300);

    // Its lease elapses. Expressed by moving the due time rather than by waiting,
    // so the test is deterministic rather than slow and occasionally wrong.
    await fixture.ownerPool.query(
      "UPDATE payments SET reconciliation_due_at = now() - interval '1 second' WHERE id = $1",
      [paymentId],
    );

    const reclaimed = await fixture.reconciliation.claimDue(50, 300);
    expect(reclaimed.map((payment) => payment.paymentId)).toContain(paymentId);
  });

  it('gives one payment to only one of two workers claiming at once', async () => {
    const { paymentId } = await uncertainPayment();

    const [left, right] = await Promise.all([
      fixture.reconciliation.claimDue(50, 300),
      fixture.reconciliation.claimDue(50, 300),
    ]);

    const claims = [...left, ...right].filter((payment) => payment.paymentId === paymentId);
    expect(claims).toHaveLength(1);
  });

  it('carries the attempt that is in doubt, with its provider reference', async () => {
    const { paymentId, providerReference } = await uncertainPayment();

    const claimed = await fixture.reconciliation.claimDue(50, 300);
    const mine = claimed.find((payment) => payment.paymentId === paymentId);

    expect(mine?.providerCode).toBe('appmax');
    expect(mine?.providerReference).toBe(providerReference);
    expect(mine?.expectedAmountMinor).toBe(10_000n);
    expect(mine?.environment).toBe('SANDBOX');
  });

  it('reports no reference when the attempt never recorded one', async () => {
    const { paymentId } = await uncertainPayment({ withReference: false });

    const claimed = await fixture.reconciliation.claimDue(50, 300);
    const mine = claimed.find((payment) => payment.paymentId === paymentId);

    expect(mine).toBeDefined();
    expect(mine?.providerReference).toBeUndefined();
  });
});

describe('recording a payment as paid', () => {
  it('moves status, capture and timestamp together', async () => {
    const { paymentId, attemptId } = await uncertainPayment();
    const paidAt = new Date('2026-09-09T11:00:00.000Z');

    const outcome = await fixture.reconciliation.applyResolution({
      paymentId,
      organizationId: fixture.merchant.id,
      attemptId,
      toStatus: 'paid',
      trigger: 'RECONCILED_PAID',
      evidenceClass: 'authenticated_provider_read',
      reason: 'Provider reported aprovado.',
      capture: { amountMinor: 10_000n, paidAt },
    });

    expect(outcome).toBe('applied');

    const payment = await readPayment(paymentId);
    expect(payment.status).toBe('paid');
    expect(payment.captured_amount_minor).toBe('10000');
    expect(payment.paid_at).toEqual(paidAt);
  });

  it('records the captured amount on the transition, not a placeholder zero', async () => {
    const { paymentId, attemptId } = await uncertainPayment();

    await fixture.reconciliation.applyResolution({
      paymentId,
      organizationId: fixture.merchant.id,
      attemptId,
      toStatus: 'paid',
      trigger: 'RECONCILED_PAID',
      evidenceClass: 'authenticated_provider_read',
      reason: 'Provider reported aprovado.',
      capture: { amountMinor: 10_000n, paidAt: new Date() },
    });

    const transitions = await fixture.ownerPool.query<{
      to_status: string;
      captured_amount_after: string;
      evidence_class: string;
    }>(
      `SELECT to_status, captured_amount_after, evidence_class
         FROM payment_status_transitions
        WHERE payment_id = $1 ORDER BY sequence_number DESC LIMIT 1`,
      [paymentId],
    );

    expect(transitions.rows[0]?.to_status).toBe('paid');
    expect(transitions.rows[0]?.captured_amount_after).toBe('10000');
    expect(transitions.rows[0]?.evidence_class).toBe('authenticated_provider_read');
  });

  it('is refused by the database when the status says paid but nothing was captured', async () => {
    // The application never does this. The point is that it could not if it tried.
    const { paymentId } = await uncertainPayment();
    const client = await fixture.applicationPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        fixture.merchant.id,
      ]);
      await expect(
        client.query('UPDATE payments SET status = $2 WHERE id = $1', [paymentId, 'paid']),
      ).rejects.toThrow(/payments_status_agrees_with_capture|check constraint/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses an edge the transition table does not declare', async () => {
    // unknown -> refunded is not reachable in one step, whatever the caller believes.
    const { paymentId, attemptId } = await uncertainPayment();

    await expect(
      fixture.reconciliation.applyResolution({
        paymentId,
        organizationId: fixture.merchant.id,
        attemptId,
        toStatus: 'refunded',
        trigger: 'REFUND_SETTLED',
        evidenceClass: 'authenticated_provider_read',
        reason: 'not a legal step',
      }),
    ).rejects.toThrow();

    const payment = await readPayment(paymentId);
    expect(payment.status).toBe('unknown');
  });

  it('refuses to fund a payment on evidence weaker than a provider read', async () => {
    const { paymentId, attemptId } = await uncertainPayment();

    await expect(
      fixture.reconciliation.applyResolution({
        paymentId,
        organizationId: fixture.merchant.id,
        attemptId,
        toStatus: 'paid',
        trigger: 'RECONCILED_PAID',
        evidenceClass: 'internal',
        reason: 'a webhook said so',
        capture: { amountMinor: 10_000n, paidAt: new Date() },
      }),
    ).rejects.toThrow();
  });
});

describe('resolving twice', () => {
  it('reports the second attempt as already resolved rather than transitioning again', async () => {
    const { paymentId, attemptId } = await uncertainPayment();
    const resolution = {
      paymentId,
      organizationId: fixture.merchant.id,
      attemptId,
      toStatus: 'expired',
      trigger: 'RECONCILED_EXPIRED',
      evidenceClass: 'authenticated_provider_read',
      reason: 'Provider reported expired.',
    };

    expect(await fixture.reconciliation.applyResolution(resolution)).toBe('applied');
    expect(await fixture.reconciliation.applyResolution(resolution)).toBe('already_resolved');

    const transitions = await fixture.ownerPool.query<{ count: string }>(
      "SELECT count(*) AS count FROM payment_status_transitions WHERE payment_id = $1 AND to_status = 'expired'",
      [paymentId],
    );
    expect(Number(transitions.rows[0]?.count)).toBe(1);
  });

  it('lets only one of two concurrent workers apply a resolution', async () => {
    const { paymentId, attemptId } = await uncertainPayment();
    const resolution = {
      paymentId,
      organizationId: fixture.merchant.id,
      attemptId,
      toStatus: 'expired',
      trigger: 'RECONCILED_EXPIRED',
      evidenceClass: 'authenticated_provider_read',
      reason: 'Provider reported expired.',
    };

    const outcomes = await Promise.all([
      fixture.reconciliation.applyResolution(resolution),
      fixture.reconciliation.applyResolution(resolution),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'applied')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'already_resolved')).toHaveLength(1);
  });

  it('refuses a stale resolution once the payment has moved on', async () => {
    // A worker that inquired before another resolved it must not overwrite the
    // newer state with what it saw earlier.
    const { paymentId, attemptId } = await uncertainPayment();

    await fixture.reconciliation.applyResolution({
      paymentId,
      organizationId: fixture.merchant.id,
      attemptId,
      toStatus: 'paid',
      trigger: 'RECONCILED_PAID',
      evidenceClass: 'authenticated_provider_read',
      reason: 'Provider reported aprovado.',
      capture: { amountMinor: 10_000n, paidAt: new Date() },
    });

    const stale = await fixture.reconciliation.applyResolution({
      paymentId,
      organizationId: fixture.merchant.id,
      attemptId,
      toStatus: 'failed',
      trigger: 'RECONCILED_FAILED',
      evidenceClass: 'authenticated_provider_read',
      reason: 'an older read said refused',
    });

    expect(stale).toBe('already_resolved');
    const payment = await readPayment(paymentId);
    expect(payment.status).toBe('paid');
  });
});

describe('deferring', () => {
  it('schedules the next inquiry without changing the payment', async () => {
    const { paymentId } = await uncertainPayment();
    const dueAt = new Date(Date.now() + 60_000);

    await fixture.reconciliation.deferResolution(
      paymentId,
      fixture.merchant.id,
      'The provider could not determine the outcome.',
      dueAt,
    );

    const payment = await readPayment(paymentId);
    expect(payment.status).toBe('unknown');
    expect(payment.reconciliation_due_at?.getTime()).toBe(dueAt.getTime());
  });

  it('stops scheduling without locking the payment', async () => {
    const { paymentId, attemptId } = await uncertainPayment();

    await fixture.reconciliation.deferResolution(
      paymentId,
      fixture.merchant.id,
      'Reconciliation stopped after 12 inquiries.',
      undefined,
    );

    const unscheduled = await readPayment(paymentId);
    expect(unscheduled.reconciliation_due_at).toBeNull();
    expect(unscheduled.status).toBe('unknown');

    const claimed = await fixture.reconciliation.claimDue(50, 300);
    expect(claimed.map((payment) => payment.paymentId)).not.toContain(paymentId);

    // Unscheduled is not stuck: an operator, or anything else, can still move it.
    const outcome = await fixture.reconciliation.applyResolution({
      paymentId,
      organizationId: fixture.merchant.id,
      attemptId,
      toStatus: 'failed',
      trigger: 'RESOLUTION_EXHAUSTED',
      evidenceClass: 'operator',
      reason: 'closed by an operator',
    });
    expect(outcome).toBe('applied');
  });

  it('counts what reconciliation has given up on', async () => {
    const { paymentId } = await uncertainPayment();
    const before = await fixture.reconciliation.countAwaitingOperator();

    await fixture.reconciliation.deferResolution(
      paymentId,
      fixture.merchant.id,
      'stopped',
      undefined,
    );

    expect(await fixture.reconciliation.countAwaitingOperator()).toBe(before + 1);
  });
});

describe('tenant isolation holds through reconciliation', () => {
  it('refuses to resolve a payment belonging to another merchant', async () => {
    const { paymentId, attemptId } = await uncertainPayment();

    await expect(
      fixture.reconciliation.applyResolution({
        paymentId,
        organizationId: fixture.otherMerchant.id,
        attemptId,
        toStatus: 'expired',
        trigger: 'RECONCILED_EXPIRED',
        evidenceClass: 'authenticated_provider_read',
        reason: 'not mine to resolve',
      }),
    ).resolves.toBe('already_resolved');

    // Reported as nothing to do rather than acted on, and the payment is untouched.
    const payment = await readPayment(paymentId);
    expect(payment.status).toBe('unknown');
  });

  it('will not defer a payment belonging to another merchant', async () => {
    const { paymentId } = await uncertainPayment();
    const before = await readPayment(paymentId);

    await fixture.reconciliation.deferResolution(
      paymentId,
      fixture.otherMerchant.id,
      'not mine',
      undefined,
    );

    const after = await readPayment(paymentId);
    expect(after.reconciliation_due_at).toEqual(before.reconciliation_due_at);
  });

  it('discovers uncertain payments across organizations, which is the one relaxation', async () => {
    const mine = await uncertainPayment();
    const theirs = await uncertainPayment({ organizationId: fixture.otherMerchant.id });

    const claimed = await fixture.reconciliation.claimDue(50, 300);
    const ids = claimed.map((payment) => payment.paymentId);

    expect(ids).toContain(mine.paymentId);
    expect(ids).toContain(theirs.paymentId);
  });
});
