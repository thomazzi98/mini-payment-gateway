import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentCreationRepository } from './payment-creation.repository.js';
import type { CreatePaymentCommand } from './payment-creation.repository.js';
import { PaymentReconciliationRepository } from './payment-reconciliation.repository.js';
import { ProviderWebhookRepository } from './provider-webhook.repository.js';
import {
  createApplicationPool,
  createOwnerPool,
  publicIdentifierFor,
  seedOrganization,
} from './test-database.js';
import type { SeededOrganization } from './test-database.js';

/**
 * Confirming ordinary payments, against real PostgreSQL.
 *
 * These properties cannot be observed against a substituted store. Duplicate
 * delivery is decided by a unique index, concurrent workers by SKIP LOCKED, and
 * the durability of a paid event by its being written in the transaction that
 * moved the money.
 */

interface Fixture {
  ownerPool: Pool;
  applicationPool: Pool;
  payments: PaymentCreationRepository;
  reconciliation: PaymentReconciliationRepository;
  webhooks: ProviderWebhookRepository;
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

interface WaitingPayment {
  readonly paymentId: string;
  readonly attemptId: string;
  readonly providerReference: string;
  readonly organizationId: string;
}

/**
 * Drives a payment to `awaiting_payment` the way a successful creation does.
 */
async function waitingPayment(
  options: { organizationId?: string; expiresAt?: Date } = {},
): Promise<WaitingPayment> {
  const organizationId = options.organizationId ?? fixture.merchant.id;
  const command = commandFor({ organizationId });
  const created = await fixture.payments.createPayment(command);
  if (created.kind !== 'created') {
    throw new Error(`expected a fresh payment, got ${created.kind}`);
  }

  const attemptId = await fixture.payments.openAttempt({
    organizationId,
    paymentId: created.paymentId,
    attemptNumber: 1,
    providerCode: 'appmax',
  });

  const providerReference = publicIdentifierFor('ref');
  await fixture.payments.applyProviderOutcome({
    organizationId,
    paymentId: created.paymentId,
    attemptId,
    outcomeClass: 'success',
    providerReference,
    failureReason: undefined,
    toStatus: 'awaiting_payment',
    trigger: 'INSTRUMENT_ISSUED',
    evidenceClass: 'authenticated_provider_read',
    idempotencyKey: command.idempotencyKey,
    environment: 'SANDBOX',
    completesRequest: true,
    responseStatus: 201,
    responseBody: { id: 'pay_rendered', status: 'awaiting_payment' },
    instrumentExpiresAt: options.expiresAt,
  });

  return { paymentId: created.paymentId, attemptId, providerReference, organizationId };
}

interface PaymentRow {
  readonly status: string;
  readonly captured_amount_minor: string;
  readonly paid_at: Date | null;
  readonly expires_at: Date | null;
  readonly reconciliation_due_at: Date | null;
  readonly reconciliation_attempts: number;
}

async function readPayment(paymentId: string): Promise<PaymentRow> {
  const result = await fixture.ownerPool.query<PaymentRow>(
    `SELECT status, captured_amount_minor, paid_at, expires_at, reconciliation_due_at,
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

function confirmation(payment: WaitingPayment) {
  return {
    paymentId: payment.paymentId,
    organizationId: payment.organizationId,
    attemptId: payment.attemptId,
    toStatus: 'paid',
    trigger: 'PAYMENT_CONFIRMED',
    evidenceClass: 'authenticated_provider_read',
    reason: 'Provider reported aprovado.',
    providerCode: 'appmax',
    providerReference: payment.providerReference,
    capture: { amountMinor: 10_000n, paidAt: new Date('2026-09-10T10:00:00.000Z') },
  };
}

/**
 * The same resolution with no money attached, for the transitions that move a
 * payment without funding it. The key is omitted rather than set to undefined,
 * which exactOptionalPropertyTypes distinguishes and which is the honest shape:
 * there is no capture, rather than a capture that is nothing.
 */
function withoutCapture(
  resolution: ReturnType<typeof confirmation>,
  toStatus: string,
  trigger: string,
) {
  const rest: Record<string, unknown> = { ...resolution };
  delete rest['capture'];
  return { ...rest, toStatus, trigger } as Omit<typeof resolution, 'capture'>;
}

beforeAll(async () => {
  fixture.ownerPool = createOwnerPool();
  fixture.applicationPool = createApplicationPool();
  fixture.payments = new PaymentCreationRepository(fixture.applicationPool);
  fixture.reconciliation = new PaymentReconciliationRepository(fixture.applicationPool);
  fixture.webhooks = new ProviderWebhookRepository(fixture.applicationPool);
  fixture.merchant = await seedOrganization(fixture.ownerPool, 'Confirmation Merchant');
  fixture.otherMerchant = await seedOrganization(fixture.ownerPool, 'Confirmation Other');
  organizationIds.push(fixture.merchant.id, fixture.otherMerchant.id);
});

afterAll(async () => {
  await fixture.ownerPool.query('DELETE FROM payment_events WHERE organization_id = ANY($1)', [
    organizationIds,
  ]);
  await fixture.ownerPool.query(
    'ALTER TABLE provider_webhook_events DISABLE TRIGGER provider_webhook_events_append_only',
  );
  await fixture.ownerPool.query(
    `DELETE FROM provider_webhook_events
      WHERE payment_id IN (SELECT id FROM payments WHERE organization_id = ANY($1))`,
    [organizationIds],
  );
  await fixture.ownerPool.query(
    'ALTER TABLE provider_webhook_events ENABLE TRIGGER provider_webhook_events_append_only',
  );
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

describe('a payment waiting to be paid is observed', () => {
  it('is scheduled the moment it becomes payable', async () => {
    // The gap this milestone exists to close: a payment reaching awaiting_payment
    // used to be observed by nothing at all.
    const payment = await waitingPayment();
    const row = await readPayment(payment.paymentId);

    expect(row.status).toBe('awaiting_payment');
    expect(row.reconciliation_due_at).not.toBeNull();
  });

  it('persists the instrument expiry, which nothing used to record', async () => {
    const expiresAt = new Date('2026-09-10T12:00:00.000Z');
    const payment = await waitingPayment({ expiresAt });

    const stored = await readPayment(payment.paymentId);
    expect(stored.expires_at).toEqual(expiresAt);
  });

  it('is claimed with the status it was claimed from', async () => {
    // The claim reports awaiting_payment rather than merging it with unknown,
    // which is what stops a polling failure from manufacturing uncertainty.
    const payment = await waitingPayment();
    const claimed = await fixture.reconciliation.claimDue(200, 300);
    const mine = claimed.find((candidate) => candidate.paymentId === payment.paymentId);

    expect(mine?.status).toBe('awaiting_payment');
    expect(mine?.providerReference).toBe(payment.providerReference);
  });

  it('gives one waiting payment to only one of two workers claiming at once', async () => {
    const payment = await waitingPayment();

    const [left, right] = await Promise.all([
      fixture.reconciliation.claimDue(200, 300),
      fixture.reconciliation.claimDue(200, 300),
    ]);

    const claims = [...left, ...right].filter(
      (candidate) => candidate.paymentId === payment.paymentId,
    );
    expect(claims).toHaveLength(1);
  });
});

describe('confirming a payment', () => {
  it('records the money, the timestamp and the transition together', async () => {
    const payment = await waitingPayment();

    expect(await fixture.reconciliation.applyResolution(confirmation(payment))).toBe('applied');

    const row = await readPayment(payment.paymentId);
    expect(row.status).toBe('paid');
    expect(row.captured_amount_minor).toBe('10000');
    expect(row.paid_at).toEqual(new Date('2026-09-10T10:00:00.000Z'));
    // Settled, so no longer asked about.
    expect(row.reconciliation_due_at).toBeNull();
  });

  it('writes the paid event in the same transaction as the money', async () => {
    // The guarantee: there is no moment at which the payment is paid and the
    // event is not there to be delivered.
    const payment = await waitingPayment();
    await fixture.reconciliation.applyResolution(confirmation(payment));

    const events = await fixture.ownerPool.query<{
      event_type: string;
      payload: Record<string, unknown>;
      published_at: Date | null;
    }>('SELECT event_type, payload, published_at FROM payment_events WHERE payment_id = $1', [
      payment.paymentId,
    ]);

    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.event_type).toBe('payment.paid');
    expect(events.rows[0]?.published_at).toBeNull();

    const payload = events.rows[0]?.payload ?? {};
    expect(payload['amountMinor']).toBe('10000');
    expect(payload['currency']).toBe('BRL');
    expect(payload['environment']).toBe('SANDBOX');
    expect(payload['provider']).toBe('appmax');
    expect(payload['providerReference']).toBe(payment.providerReference);
    expect(payload['paymentAttemptId']).toBe(payment.attemptId);
  });

  it('carries no secret in the event a consumer will read', async () => {
    const payment = await waitingPayment();
    await fixture.reconciliation.applyResolution(confirmation(payment));

    const events = await fixture.ownerPool.query<{ payload: unknown }>(
      'SELECT payload FROM payment_events WHERE payment_id = $1',
      [payment.paymentId],
    );
    const serialized = JSON.stringify(events.rows[0]?.payload);

    for (const forbidden of ['token', 'secret', 'password', 'authorization', 'pepper']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('rolls the event back with the money when the transition is refused', async () => {
    // Neither exists without the other, in either direction.
    const payment = await waitingPayment();

    await expect(
      fixture.reconciliation.applyResolution({
        ...confirmation(payment),
        trigger: 'NOT_A_REAL_TRIGGER',
      }),
    ).rejects.toThrow();

    const events = await fixture.ownerPool.query<{ count: string }>(
      'SELECT count(*) AS count FROM payment_events WHERE payment_id = $1',
      [payment.paymentId],
    );
    expect(Number(events.rows[0]?.count)).toBe(0);
    const settledStatus = await readPayment(payment.paymentId);
    expect(settledStatus.status).toBe('awaiting_payment');
  });

  it('confirms once when two workers confirm at the same moment', async () => {
    const payment = await waitingPayment();

    const outcomes = await Promise.all([
      fixture.reconciliation.applyResolution(confirmation(payment)),
      fixture.reconciliation.applyResolution(confirmation(payment)),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'applied')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'already_resolved')).toHaveLength(1);

    const events = await fixture.ownerPool.query<{ count: string }>(
      'SELECT count(*) AS count FROM payment_events WHERE payment_id = $1',
      [payment.paymentId],
    );
    expect(Number(events.rows[0]?.count)).toBe(1);
  });
});

describe('a payment that is already settled', () => {
  it('cannot be confirmed a second time', async () => {
    const payment = await waitingPayment();
    await fixture.reconciliation.applyResolution(confirmation(payment));

    expect(await fixture.reconciliation.applyResolution(confirmation(payment))).toBe(
      'already_resolved',
    );
  });

  it('cannot be expired after it is paid', async () => {
    // Expiring a payment whose money arrived would be taking the customer's money
    // and denying they paid.
    const payment = await waitingPayment();
    await fixture.reconciliation.applyResolution(confirmation(payment));

    const outcome = await fixture.reconciliation.applyResolution(
      withoutCapture(confirmation(payment), 'expired', 'EXPIRY_ELAPSED'),
    );

    expect(outcome).toBe('already_resolved');
    const settledStatus = await readPayment(payment.paymentId);
    expect(settledStatus.status).toBe('paid');
  });

  it('refuses paid to failed, whatever a late event claims', async () => {
    const payment = await waitingPayment();
    await fixture.reconciliation.applyResolution(confirmation(payment));

    const outcome = await fixture.reconciliation.applyResolution(
      withoutCapture(confirmation(payment), 'failed', 'PAYMENT_REFUSED'),
    );

    expect(outcome).toBe('already_resolved');
    const settledStatus = await readPayment(payment.paymentId);
    expect(settledStatus.status).toBe('paid');
  });

  it('refuses an expired payment being marked paid by this path', async () => {
    // expired -> paid exists, but only through LATE_PAYMENT_CONFIRMED. Reaching
    // it with the confirmation trigger is refused by the transition table.
    const payment = await waitingPayment();
    await fixture.reconciliation.applyResolution(
      withoutCapture(confirmation(payment), 'expired', 'EXPIRY_ELAPSED'),
    );

    const outcome = await fixture.reconciliation.applyResolution(confirmation(payment));
    expect(outcome).toBe('already_resolved');
    const settledStatus = await readPayment(payment.paymentId);
    expect(settledStatus.status).toBe('expired');
  });
});

describe('notifications resolve to exactly one payment', () => {
  it('finds the payment that holds the provider reference', async () => {
    const payment = await waitingPayment();
    const matched = await fixture.webhooks.findPaymentByProviderReference(
      'appmax',
      payment.providerReference,
    );

    expect(matched).toEqual({
      paymentId: payment.paymentId,
      organizationId: fixture.merchant.id,
    });
  });

  it('finds nothing for a reference nobody holds', async () => {
    expect(
      await fixture.webhooks.findPaymentByProviderReference('appmax', 'not-a-real-reference'),
    ).toBeUndefined();
  });

  it('finds nothing for the right reference under the wrong provider', async () => {
    const payment = await waitingPayment();

    expect(
      await fixture.webhooks.findPaymentByProviderReference('other', payment.providerReference),
    ).toBeUndefined();
  });

  it('returns the owning merchant, so a notification cannot reach another', async () => {
    // Ownership travels with the reference. A notification naming this reference
    // resolves to this merchant and no other, whoever sent it.
    const theirs = await waitingPayment({ organizationId: fixture.otherMerchant.id });
    const matched = await fixture.webhooks.findPaymentByProviderReference(
      'appmax',
      theirs.providerReference,
    );

    expect(matched?.organizationId).toBe(fixture.otherMerchant.id);
    expect(matched?.organizationId).not.toBe(fixture.merchant.id);
  });
});

describe('duplicate notification delivery', () => {
  it('records the first and reports the second as a duplicate', async () => {
    const payment = await waitingPayment();
    const event = {
      providerCode: 'appmax',
      providerEventId: `evt-${publicIdentifierFor('e')}`,
      eventType: 'order_paid_by_pix',
      providerReference: payment.providerReference,
      paymentId: payment.paymentId,
      organizationId: fixture.merchant.id,
      disposition: 'scheduled_read' as const,
    };

    expect(await fixture.webhooks.recordEvent(event)).toBe('recorded');
    expect(await fixture.webhooks.recordEvent(event)).toBe('duplicate');
    expect(await fixture.webhooks.recordEvent(event)).toBe('duplicate');
  });

  it('records exactly one row when the same delivery arrives concurrently', async () => {
    // At-least-once delivery plus more than one instance means simultaneous
    // duplicates are ordinary. The unique index decides, not any code path.
    const payment = await waitingPayment();
    const event = {
      providerCode: 'appmax',
      providerEventId: `evt-${publicIdentifierFor('e')}`,
      eventType: 'order_paid_by_pix',
      providerReference: payment.providerReference,
      paymentId: payment.paymentId,
      organizationId: fixture.merchant.id,
      disposition: 'scheduled_read' as const,
    };

    const outcomes = await Promise.all([
      fixture.webhooks.recordEvent(event),
      fixture.webhooks.recordEvent(event),
      fixture.webhooks.recordEvent(event),
      fixture.webhooks.recordEvent(event),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'recorded')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(3);

    const stored = await fixture.ownerPool.query<{ count: string }>(
      'SELECT count(*) AS count FROM provider_webhook_events WHERE provider_event_id = $1',
      [event.providerEventId],
    );
    expect(Number(stored.rows[0]?.count)).toBe(1);
  });

  it('cannot be rewritten once recorded', async () => {
    const payment = await waitingPayment();
    const providerEventId = `evt-${publicIdentifierFor('e')}`;
    await fixture.webhooks.recordEvent({
      providerCode: 'appmax',
      providerEventId,
      eventType: 'order_paid_by_pix',
      providerReference: payment.providerReference,
      paymentId: payment.paymentId,
      organizationId: fixture.merchant.id,
      disposition: 'scheduled_read',
    });

    await expect(
      fixture.ownerPool.query(
        "UPDATE provider_webhook_events SET event_type = 'order_refund' WHERE provider_event_id = $1",
        [providerEventId],
      ),
    ).rejects.toThrow(/append_only/);
  });
});

describe('a notification brings the next inquiry forward', () => {
  it('makes a leased payment due again immediately', async () => {
    const payment = await waitingPayment();
    await fixture.reconciliation.claimDue(200, 3600);

    const leased = await readPayment(payment.paymentId);
    expect(leased.reconciliation_due_at?.getTime()).toBeGreaterThan(Date.now());

    await fixture.webhooks.bringInquiryForward(payment.paymentId, fixture.merchant.id);

    const hurried = await readPayment(payment.paymentId);
    expect(hurried.reconciliation_due_at?.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('changes nothing about a payment that is already settled', async () => {
    const payment = await waitingPayment();
    await fixture.reconciliation.applyResolution(confirmation(payment));

    await fixture.webhooks.bringInquiryForward(payment.paymentId, fixture.merchant.id);

    const row = await readPayment(payment.paymentId);
    expect(row.status).toBe('paid');
    expect(row.reconciliation_due_at).toBeNull();
  });

  it('changes nothing for a merchant the payment does not belong to', async () => {
    const payment = await waitingPayment();
    await fixture.reconciliation.claimDue(200, 3600);
    const before = await readPayment(payment.paymentId);

    await fixture.webhooks.bringInquiryForward(payment.paymentId, fixture.otherMerchant.id);

    const after = await readPayment(payment.paymentId);
    expect(after.reconciliation_due_at).toEqual(before.reconciliation_due_at);
  });
});
