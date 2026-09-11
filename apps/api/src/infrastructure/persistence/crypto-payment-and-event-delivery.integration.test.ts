import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PresentedInstrument } from '../../application/create-payment.use-case.js';
import { PaymentCreationRepository } from './payment-creation.repository.js';
import type { CreatePaymentCommand } from './payment-creation.repository.js';
import { PaymentEventRepository } from './payment-event.repository.js';
import { PaymentReadRepository } from './payment-read.repository.js';
import { PaymentReconciliationRepository } from './payment-reconciliation.repository.js';
import {
  createApplicationPool,
  createOwnerPool,
  publicIdentifierFor,
  seedOrganization,
} from './test-database.js';
import type { SeededOrganization } from './test-database.js';

/**
 * A crypto payment's full life against real PostgreSQL: created with a stored
 * destination, read back by its owner and by nobody else, confirmed on an
 * authenticated read, and its paid event claimed, leased and closed by the
 * delivery queue.
 */

interface Fixture {
  ownerPool: Pool;
  applicationPool: Pool;
  payments: PaymentCreationRepository;
  reads: PaymentReadRepository;
  reconciliation: PaymentReconciliationRepository;
  events: PaymentEventRepository;
  merchant: SeededOrganization;
  otherMerchant: SeededOrganization;
}

const fixture = {} as Fixture;
const organizationIds: string[] = [];

const INSTRUMENT: PresentedInstrument = {
  type: 'crypto',
  network: 'polygon',
  asset: 'USDC',
  destinationAddress: '0x1077840bd639dbd769cb7dde82235d265e73f28a',
  paymentUri: 'ethereum:0x5fbd@31337/transfer?address=0x1077&uint256=150000',
  qrCodeImageDataUri: 'data:image/png;base64,BBBB',
  expiresAt: '2026-09-11T00:30:00.000Z',
};

function commandFor(overrides: Partial<CreatePaymentCommand> = {}): CreatePaymentCommand {
  const reference = `reference-${publicIdentifierFor('r')}`;
  return {
    organizationId: fixture.merchant.id,
    environment: 'SANDBOX',
    merchantReference: reference,
    paymentMethod: 'crypto',
    currency: 'USDC',
    expectedAmountMinor: 150_000n,
    customerPhone: '+5515999998888',
    idempotencyKey: `key-${publicIdentifierFor('k')}`,
    requestPath: '/v1/payments',
    requestBody: { amount: 150_000, currency: 'USDC', reference },
    ...overrides,
  };
}

interface CreatedPayment {
  readonly paymentId: string;
  readonly publicId: string;
  readonly attemptId: string;
  readonly providerReference: string;
}

async function awaitingCryptoPayment(
  overrides: Partial<CreatePaymentCommand> = {},
): Promise<CreatedPayment> {
  const command = commandFor(overrides);
  const created = await fixture.payments.createPayment(command);
  if (created.kind !== 'created') {
    throw new Error(`expected a fresh payment, got ${created.kind}`);
  }
  const attemptId = await fixture.payments.openAttempt({
    organizationId: command.organizationId,
    paymentId: created.paymentId,
    attemptNumber: 1,
    providerCode: 'cryptopay',
  });
  const providerReference = `pay_${publicIdentifierFor('cp')}`;
  await fixture.payments.applyProviderOutcome({
    organizationId: command.organizationId,
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
    responseBody: { id: created.publicId, status: 'awaiting_payment' },
    instrumentExpiresAt: new Date(INSTRUMENT.expiresAt ?? ''),
    instrument: INSTRUMENT,
  });
  return { paymentId: created.paymentId, publicId: created.publicId, attemptId, providerReference };
}

async function confirm(payment: CreatedPayment): Promise<void> {
  const outcome = await fixture.reconciliation.applyResolution({
    paymentId: payment.paymentId,
    organizationId: fixture.merchant.id,
    attemptId: payment.attemptId,
    toStatus: 'paid',
    trigger: 'PAYMENT_CONFIRMED',
    evidenceClass: 'authenticated_provider_read',
    reason: 'Provider reported PAID.',
    providerCode: 'cryptopay',
    providerReference: payment.providerReference,
    capture: { amountMinor: 150_000n, paidAt: new Date('2026-09-11T00:04:00.000Z') },
  });
  expect(outcome).toBe('applied');
}

async function eventRow(paymentId: string) {
  const result = await fixture.ownerPool.query<{
    id: string;
    delivery_status: string;
    delivery_reference: string | null;
    published_at: Date | null;
    attempts: number;
    last_failure: string | null;
    payload: Record<string, unknown>;
  }>(
    `SELECT id, delivery_status, delivery_reference, published_at, attempts, last_failure, payload
       FROM payment_events WHERE payment_id = $1`,
    [paymentId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('the paid event was not written');
  }
  return row;
}

beforeAll(async () => {
  fixture.ownerPool = createOwnerPool();
  fixture.applicationPool = createApplicationPool();
  fixture.payments = new PaymentCreationRepository(fixture.applicationPool);
  fixture.reads = new PaymentReadRepository(fixture.applicationPool);
  fixture.reconciliation = new PaymentReconciliationRepository(fixture.applicationPool);
  fixture.events = new PaymentEventRepository(fixture.applicationPool);
  fixture.merchant = await seedOrganization(fixture.ownerPool, 'Crypto Merchant');
  fixture.otherMerchant = await seedOrganization(fixture.ownerPool, 'Crypto Other');
  organizationIds.push(fixture.merchant.id, fixture.otherMerchant.id);
});

afterAll(async () => {
  await fixture.ownerPool.query('DELETE FROM payment_events WHERE organization_id = ANY($1)', [
    organizationIds,
  ]);
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
  await fixture.applicationPool.end();
  await fixture.ownerPool.end();
});

describe('a crypto payment in the database', () => {
  it('is stored with its asset, its recipient and the destination it was shown', async () => {
    const payment = await awaitingCryptoPayment();

    const snapshot = await fixture.reads.findByPublicId({
      organizationId: fixture.merchant.id,
      environment: 'SANDBOX',
      publicId: payment.publicId,
    });

    expect(snapshot?.paymentMethod).toBe('crypto');
    expect(snapshot?.currency).toBe('USDC');
    expect(snapshot?.status).toBe('awaiting_payment');
    expect(snapshot?.providerCode).toBe('cryptopay');
    expect(snapshot?.providerReference).toBe(payment.providerReference);
    expect(snapshot?.instrument).toEqual(INSTRUMENT);
    expect(snapshot?.expiresAt).toEqual(new Date('2026-09-11T00:30:00.000Z'));
    expect(snapshot?.transitions.map((transition) => transition.toStatus)).toEqual([
      'processing',
      'awaiting_payment',
    ]);
  });

  it('is invisible to another organization and to the other environment', async () => {
    const payment = await awaitingCryptoPayment();

    const asOther = await fixture.reads.findByPublicId({
      organizationId: fixture.otherMerchant.id,
      environment: 'SANDBOX',
      publicId: payment.publicId,
    });
    const asProduction = await fixture.reads.findByPublicId({
      organizationId: fixture.merchant.id,
      environment: 'PRODUCTION',
      publicId: payment.publicId,
    });

    expect(asOther).toBeUndefined();
    expect(asProduction).toBeUndefined();
  });

  it('refuses an asset code the column cannot hold', async () => {
    await expect(fixture.payments.createPayment(commandFor({ currency: 'usdc' }))).rejects.toThrow(
      /asset_code/,
    );
  });

  it('refuses a recipient that is not international', async () => {
    await expect(
      fixture.payments.createPayment(commandFor({ customerPhone: '15999998888' })),
    ).rejects.toThrow(/customer_phone/);
  });
});

describe('the paid event and its delivery', () => {
  it('carries the method and the recipient, and reads back as pending', async () => {
    const payment = await awaitingCryptoPayment();
    await confirm(payment);

    const row = await eventRow(payment.paymentId);
    expect(row.delivery_status).toBe('pending');
    expect(row.payload).toMatchObject({
      paymentId: payment.publicId,
      paymentMethod: 'crypto',
      currency: 'USDC',
      amountMinor: '150000',
      customerPhone: '+5515999998888',
      provider: 'cryptopay',
      providerReference: payment.providerReference,
    });

    const snapshot = await fixture.reads.findByPublicId({
      organizationId: fixture.merchant.id,
      environment: 'SANDBOX',
      publicId: payment.publicId,
    });
    expect(snapshot?.status).toBe('paid');
    expect(snapshot?.events).toEqual([
      expect.objectContaining({ type: 'payment.paid', deliveryStatus: 'pending', attempts: 0 }),
    ]);
  });

  it('is claimed once per lease, and closed as delivered with its reference', async () => {
    const payment = await awaitingCryptoPayment();
    await confirm(payment);
    const row = await eventRow(payment.paymentId);

    const first = await fixture.events.claimDue(100, 60);
    const claimed = first.find((event) => event.eventId === row.id);
    expect(claimed).toMatchObject({
      eventId: row.id,
      organizationId: fixture.merchant.id,
      eventType: 'payment.paid',
      attempts: 1,
    });

    // Leased: a second worker asking immediately does not receive it.
    const second = await fixture.events.claimDue(100, 60);
    expect(second.find((event) => event.eventId === row.id)).toBeUndefined();

    await fixture.events.markDelivered({
      eventId: row.id,
      organizationId: fixture.merchant.id,
      reference: 'notification-1',
    });

    const after = await eventRow(payment.paymentId);
    expect(after.delivery_status).toBe('delivered');
    expect(after.delivery_reference).toBe('notification-1');
    expect(after.published_at).not.toBeNull();

    // Closed events are never claimed again, whatever the lease says.
    await fixture.ownerPool.query(
      'UPDATE payment_events SET next_attempt_at = now() WHERE id = $1',
      [row.id],
    );
    const third = await fixture.events.claimDue(100, 60);
    expect(third.find((event) => event.eventId === row.id)).toBeUndefined();
  });

  it('cannot be marked delivered without a reference, by anyone', async () => {
    const payment = await awaitingCryptoPayment();
    await confirm(payment);
    const row = await eventRow(payment.paymentId);

    await expect(
      fixture.ownerPool.query(
        `UPDATE payment_events SET delivery_status = 'delivered', published_at = now()
          WHERE id = $1`,
        [row.id],
      ),
    ).rejects.toThrow(/payment_events_delivered_carry_reference/);
    await expect(
      fixture.ownerPool.query(
        `UPDATE payment_events SET delivery_status = 'delivered', delivery_reference = 'n'
          WHERE id = $1`,
        [row.id],
      ),
    ).rejects.toThrow(/payment_events_published_shape/);
  });

  it('defers with the failure recorded, and skips when nobody can be told', async () => {
    const deferred = await awaitingCryptoPayment();
    await confirm(deferred);
    const deferredRow = await eventRow(deferred.paymentId);
    const dueAt = new Date(Date.now() + 60_000);
    await fixture.events.defer({
      eventId: deferredRow.id,
      organizationId: fixture.merchant.id,
      dueAt,
      failure: 'answered 503',
    });
    const afterDefer = await eventRow(deferred.paymentId);
    expect(afterDefer.delivery_status).toBe('pending');
    expect(afterDefer.last_failure).toBe('answered 503');
    const claimedNow = await fixture.events.claimDue(100, 60);
    expect(claimedNow.map((event) => event.eventId)).not.toContain(deferredRow.id);

    const silent = await awaitingCryptoPayment({ customerPhone: undefined });
    await confirm(silent);
    const silentRow = await eventRow(silent.paymentId);
    expect(silentRow.payload['customerPhone']).toBeNull();
    await fixture.events.markSkipped({
      eventId: silentRow.id,
      organizationId: fixture.merchant.id,
      reason: 'nobody to notify',
    });
    const skipped = await eventRow(silent.paymentId);
    expect(skipped.delivery_status).toBe('skipped');
  });

  it('is not writable across tenants', async () => {
    const payment = await awaitingCryptoPayment();
    await confirm(payment);
    const row = await eventRow(payment.paymentId);

    await fixture.events.markDelivered({
      eventId: row.id,
      organizationId: fixture.otherMerchant.id,
      reference: 'stolen',
    });

    const untouched = await eventRow(payment.paymentId);
    expect(untouched.delivery_status).toBe('pending');
  });
});
