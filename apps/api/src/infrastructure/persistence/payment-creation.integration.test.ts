import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentCreationRepository } from './payment-creation.repository.js';
import type { CreatePaymentCommand } from './payment-creation.repository.js';
import {
  createApplicationPool,
  createOwnerPool,
  publicIdentifierFor,
  seedOrganization,
} from './test-database.js';
import type { SeededOrganization } from './test-database.js';

/**
 * The full creation cycle against real PostgreSQL: claim, open an attempt, apply
 * the provider outcome.
 *
 * These exist because the unit tests substitute the store, so every constraint
 * that makes the cycle correct — the legal-transition foreign key, the audit
 * trigger, row level security — is invisible to them. The first run of this file
 * found that the outcome transition was illegal: the payment was still `pending`
 * while the only edges to `awaiting_payment`, `failed` and `unknown` leave
 * `processing`.
 */

interface Fixture {
  ownerPool: Pool;
  applicationPool: Pool;
  repository: PaymentCreationRepository;
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

interface CreatedPayment {
  readonly paymentId: string;
  readonly command: CreatePaymentCommand;
}

async function claimPayment(
  overrides: Partial<CreatePaymentCommand> = {},
): Promise<CreatedPayment> {
  const command = commandFor(overrides);
  const claimed = await fixture.repository.createPayment(command);
  if (claimed.kind !== 'created') {
    throw new Error(`expected a fresh payment, got ${claimed.kind}`);
  }
  return { paymentId: claimed.paymentId, command };
}

interface PaymentRow {
  readonly status: string;
  readonly status_sequence: string;
}

async function readPayment(paymentId: string): Promise<PaymentRow> {
  const result = await fixture.ownerPool.query<PaymentRow>(
    'SELECT status, status_sequence FROM payments WHERE id = $1',
    [paymentId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('the payment was not found');
  }
  return row;
}

interface AttemptRow {
  readonly attempt_number: number;
  readonly provider_code: string;
  readonly outcome_class: string | null;
  readonly provider_reference: string | null;
  readonly failure_reason: string | null;
  readonly finished_at: Date | null;
}

async function readAttempts(paymentId: string): Promise<AttemptRow[]> {
  const result = await fixture.ownerPool.query<AttemptRow>(
    `SELECT attempt_number, provider_code, outcome_class, provider_reference,
            failure_reason, finished_at
       FROM payment_attempts WHERE payment_id = $1 ORDER BY attempt_number`,
    [paymentId],
  );
  return result.rows;
}

interface TransitionRow {
  readonly sequence_number: string;
  readonly from_status: string;
  readonly to_status: string;
  readonly trigger_name: string;
  readonly evidence_class: string;
  readonly payment_attempt_id: string | null;
}

async function readTransitions(paymentId: string): Promise<TransitionRow[]> {
  const result = await fixture.ownerPool.query<TransitionRow>(
    `SELECT sequence_number, from_status, to_status, trigger_name, evidence_class,
            payment_attempt_id
       FROM payment_status_transitions WHERE payment_id = $1 ORDER BY sequence_number`,
    [paymentId],
  );
  return result.rows;
}

interface IdempotencyRow {
  readonly state: string;
  readonly response_status: number | null;
  readonly response_body: unknown;
  readonly payment_id: string | null;
}

async function readIdempotencyRecord(key: string): Promise<IdempotencyRow> {
  const result = await fixture.ownerPool.query<IdempotencyRow>(
    `SELECT state, response_status, response_body, payment_id
       FROM idempotency_records WHERE idempotency_key = $1`,
    [key],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('the idempotency record was not found');
  }
  return row;
}

/**
 * Drives one payment through the whole cycle, the way the use case does.
 */
async function runCycle(outcome: {
  readonly outcomeClass: string;
  readonly toStatus: string;
  readonly trigger: string;
  readonly evidenceClass: string;
  /**
   * Whether the provider named something. The reference itself is generated,
   * because payment_attempts_provider_reference is unique across the whole table:
   * two payments may never claim the same provider transaction.
   */
  readonly withProviderReference?: boolean;
  readonly failureReason?: string;
  readonly responseStatus: number;
}): Promise<CreatedPayment & { attemptId: string; providerReference: string | undefined }> {
  const providerReference =
    outcome.withProviderReference === true ? publicIdentifierFor('ref') : undefined;
  const created = await claimPayment();
  const attemptId = await fixture.repository.openAttempt({
    organizationId: created.command.organizationId,
    paymentId: created.paymentId,
    attemptNumber: 1,
    providerCode: 'appmax',
  });

  await fixture.repository.applyProviderOutcome({
    organizationId: created.command.organizationId,
    paymentId: created.paymentId,
    attemptId,
    outcomeClass: outcome.outcomeClass,
    providerReference,
    failureReason: outcome.failureReason,
    toStatus: outcome.toStatus,
    trigger: outcome.trigger,
    evidenceClass: outcome.evidenceClass,
    idempotencyKey: created.command.idempotencyKey,
    environment: 'SANDBOX',
    responseStatus: outcome.responseStatus,
    responseBody: { id: 'pay_rendered', status: outcome.toStatus },
  });

  return { ...created, attemptId, providerReference };
}

beforeAll(async () => {
  fixture.ownerPool = createOwnerPool();
  fixture.applicationPool = createApplicationPool();
  fixture.repository = new PaymentCreationRepository(fixture.applicationPool);
  fixture.merchant = await seedOrganization(fixture.ownerPool, 'Creation Merchant');
  fixture.otherMerchant = await seedOrganization(fixture.ownerPool, 'Creation Other Merchant');
  organizationIds.push(fixture.merchant.id, fixture.otherMerchant.id);
});

afterAll(async () => {
  // The append-only trigger refuses this, which is the point of it. Test teardown
  // suspends it deliberately rather than the trigger being weakened for everyone.
  await fixture.ownerPool.query(
    'ALTER TABLE payment_status_transitions DISABLE TRIGGER payment_status_transitions_append_only',
  );
  for (const organizationId of organizationIds) {
    await fixture.ownerPool.query(
      'DELETE FROM payment_status_transitions WHERE organization_id = $1',
      [organizationId],
    );
    await fixture.ownerPool.query('DELETE FROM payment_attempts WHERE organization_id = $1', [
      organizationId,
    ]);
    await fixture.ownerPool.query('DELETE FROM idempotency_records WHERE organization_id = $1', [
      organizationId,
    ]);
    await fixture.ownerPool.query('DELETE FROM payments WHERE organization_id = $1', [
      organizationId,
    ]);
    await fixture.ownerPool.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
  }
  await fixture.ownerPool.query(
    'ALTER TABLE payment_status_transitions ENABLE TRIGGER payment_status_transitions_append_only',
  );
  await fixture.ownerPool.end();
  await fixture.applicationPool.end();
});

describe('opening an attempt', () => {
  it('records that a provider request was sent, before it is sent', async () => {
    // Committed ahead of the network call: a crash mid-flight must leave evidence
    // that something was tried, or a payment that reached a provider looks
    // untouched and reconciliation has nothing to find.
    const created = await claimPayment();
    const beforeOpening = await readPayment(created.paymentId);
    expect(beforeOpening.status).toBe('pending');

    const attemptId = await fixture.repository.openAttempt({
      organizationId: created.command.organizationId,
      paymentId: created.paymentId,
      attemptNumber: 1,
      providerCode: 'appmax',
    });

    const payment = await readPayment(created.paymentId);
    expect(payment.status).toBe('processing');
    expect(payment.status_sequence).toBe('1');

    const attempts = await readAttempts(created.paymentId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.provider_code).toBe('appmax');
    expect(attempts[0]?.attempt_number).toBe(1);
    // Open: no outcome, no finish. This is the shape reconciliation looks for.
    expect(attempts[0]?.outcome_class).toBeNull();
    expect(attempts[0]?.finished_at).toBeNull();

    const transitions = await readTransitions(created.paymentId);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.from_status).toBe('pending');
    expect(transitions[0]?.to_status).toBe('processing');
    expect(transitions[0]?.trigger_name).toBe('PROVIDER_REQUEST_SENT');
    expect(transitions[0]?.payment_attempt_id).toBe(attemptId);
  });

  it('refuses to open an attempt on another merchant’s payment', async () => {
    const created = await claimPayment();

    await expect(
      fixture.repository.openAttempt({
        organizationId: fixture.otherMerchant.id,
        paymentId: created.paymentId,
        attemptNumber: 1,
        providerCode: 'appmax',
      }),
    ).rejects.toThrow();

    // And the payment it was aimed at is untouched.
    const untouched = await readPayment(created.paymentId);
    expect(untouched.status).toBe('pending');
    expect(await readAttempts(created.paymentId)).toHaveLength(0);
  });
});

describe('applying a successful provider outcome', () => {
  it('closes the attempt, moves the payment and completes the idempotency record', async () => {
    const cycle = await runCycle({
      outcomeClass: 'success',
      toStatus: 'awaiting_payment',
      trigger: 'INSTRUMENT_ISSUED',
      evidenceClass: 'authenticated_provider_read',
      withProviderReference: true,
      responseStatus: 201,
    });

    const payment = await readPayment(cycle.paymentId);
    expect(payment.status).toBe('awaiting_payment');
    expect(payment.status_sequence).toBe('2');

    const attempts = await readAttempts(cycle.paymentId);
    expect(attempts[0]?.outcome_class).toBe('success');
    expect(attempts[0]?.provider_reference).toBe(cycle.providerReference);
    expect(attempts[0]?.finished_at).not.toBeNull();

    const transitions = await readTransitions(cycle.paymentId);
    expect(transitions.map((row) => row.to_status)).toEqual(['processing', 'awaiting_payment']);
    expect(transitions[1]?.trigger_name).toBe('INSTRUMENT_ISSUED');
    expect(transitions[1]?.evidence_class).toBe('authenticated_provider_read');
    // Every transition names the attempt that caused it, which is what makes
    // "why is this payment in this state?" answerable.
    expect(transitions[1]?.payment_attempt_id).toBe(cycle.attemptId);

    const record = await readIdempotencyRecord(cycle.command.idempotencyKey);
    expect(record.state).toBe('completed');
    expect(record.response_status).toBe(201);
    expect(record.payment_id).toBe(cycle.paymentId);
  });

  it('keeps the provider reference on the attempt and never on the payment', async () => {
    // A payment may be attempted against several providers. A column on the
    // payment could hold only one of them, and would silently become whichever
    // was written last.
    const columns = await fixture.ownerPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'payments' AND column_name LIKE '%provider%'`,
    );
    expect(columns.rows).toEqual([]);
  });
});

describe('applying an outcome that is not a success', () => {
  it('records an unknown outcome as unknown, never as failed', async () => {
    // The request may have reached the provider and may have created something
    // payable. Recording a failure would be a claim we cannot support.
    const cycle = await runCycle({
      outcomeClass: 'unknown_outcome',
      toStatus: 'unknown',
      trigger: 'PROVIDER_OUTCOME_UNKNOWN',
      evidenceClass: 'internal',
      withProviderReference: true,
      failureReason: 'the provider did not answer within the timeout',
      responseStatus: 202,
    });

    const payment = await readPayment(cycle.paymentId);
    expect(payment.status).toBe('unknown');

    const attempts = await readAttempts(cycle.paymentId);
    expect(attempts[0]?.outcome_class).toBe('unknown_outcome');
    // Carried through so reconciliation has something authoritative to read back.
    expect(attempts[0]?.provider_reference).toBe(cycle.providerReference);

    const record = await readIdempotencyRecord(cycle.command.idempotencyKey);
    expect(record.response_status).toBe(202);
  });

  it('records a definitive refusal as failed', async () => {
    const cycle = await runCycle({
      outcomeClass: 'definitive_failure',
      toStatus: 'failed',
      trigger: 'PROVIDER_REFUSED',
      evidenceClass: 'authenticated_provider_read',
      failureReason: 'the provider refused the payment',
      responseStatus: 402,
    });

    const payment = await readPayment(cycle.paymentId);
    expect(payment.status).toBe('failed');

    const attempts = await readAttempts(cycle.paymentId);
    expect(attempts[0]?.failure_reason).toBe('the provider refused the payment');

    const record = await readIdempotencyRecord(cycle.command.idempotencyKey);
    expect(record.response_status).toBe(402);
  });

  it('returns a safe failure to pending, so another provider could be tried', async () => {
    const cycle = await runCycle({
      outcomeClass: 'safe_failure',
      toStatus: 'pending',
      trigger: 'SAFE_FAILURE_OBSERVED',
      evidenceClass: 'authenticated_provider_read',
      failureReason: 'the request was rejected before anything was created',
      responseStatus: 402,
    });

    const payment = await readPayment(cycle.paymentId);
    expect(payment.status).toBe('pending');

    const transitions = await readTransitions(cycle.paymentId);
    expect(transitions.map((row) => row.to_status)).toEqual(['processing', 'pending']);
  });
});

describe('a payment nothing can route', () => {
  it('fails the payment and releases the claim, rather than stranding the key', async () => {
    // Before this was handled, every unroutable request left its key answering
    // "still being processed" to every retry forever, while the orphaned payment
    // went on holding the merchant reference.
    const created = await claimPayment();

    await fixture.repository.failRouting({
      organizationId: created.command.organizationId,
      paymentId: created.paymentId,
      reason: 'No configured provider can serve pix in BRL.',
      idempotencyKey: created.command.idempotencyKey,
      environment: 'SANDBOX',
      responseStatus: 422,
      responseBody: { id: 'pay_rendered', status: 'failed' },
    });

    const payment = await readPayment(created.paymentId);
    expect(payment.status).toBe('failed');

    const transitions = await readTransitions(created.paymentId);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.to_status).toBe('failed');
    expect(transitions[0]?.trigger_name).toBe('ROUTING_EXHAUSTED');
    // No provider was contacted, so there is no attempt to point at.
    expect(transitions[0]?.payment_attempt_id).toBeNull();
    expect(await readAttempts(created.paymentId)).toHaveLength(0);

    const record = await readIdempotencyRecord(created.command.idempotencyKey);
    expect(record.state).toBe('completed');
    expect(record.response_status).toBe(422);
  });

  it('lets the same key be retried and replayed instead of answering in flight', async () => {
    const created = await claimPayment();
    await fixture.repository.failRouting({
      organizationId: created.command.organizationId,
      paymentId: created.paymentId,
      reason: 'nothing can serve it',
      idempotencyKey: created.command.idempotencyKey,
      environment: 'SANDBOX',
      responseStatus: 422,
      responseBody: { id: 'pay_rendered', status: 'failed' },
    });

    const replayed = await fixture.repository.createPayment(created.command);
    expect(replayed.kind).toBe('replayed');
    if (replayed.kind !== 'replayed') {
      throw new Error('expected a replay');
    }
    expect(replayed.responseStatus).toBe(422);
  });

  it('frees the merchant reference, so the merchant can try again', async () => {
    // A live payment holds its reference. A failed one must not, or a merchant
    // whose first attempt could not be routed can never use that reference again.
    const created = await claimPayment();
    await fixture.repository.failRouting({
      organizationId: created.command.organizationId,
      paymentId: created.paymentId,
      reason: 'nothing can serve it',
      idempotencyKey: created.command.idempotencyKey,
      environment: 'SANDBOX',
      responseStatus: 422,
      responseBody: { id: 'pay_rendered', status: 'failed' },
    });

    const retried = await fixture.repository.createPayment(
      commandFor({ merchantReference: created.command.merchantReference }),
    );
    expect(retried.kind).toBe('created');
  });
});

describe('the idempotency record reflects what the caller was told', () => {
  it('stays in flight until the provider has answered', async () => {
    // Completing it at creation time would let a replay return a payment that has
    // no instrument yet, and with a status the caller never received.
    const created = await claimPayment();

    const record = await readIdempotencyRecord(created.command.idempotencyKey);
    expect(record.state).toBe('in_flight');
    expect(record.response_status).toBeNull();
    expect(record.payment_id).toBe(created.paymentId);

    const replayed = await fixture.repository.createPayment(created.command);
    expect(replayed.kind).toBe('in_flight');
  });

  it('replays the stored status and body once the cycle has finished', async () => {
    const cycle = await runCycle({
      outcomeClass: 'unknown_outcome',
      toStatus: 'unknown',
      trigger: 'PROVIDER_OUTCOME_UNKNOWN',
      evidenceClass: 'internal',
      failureReason: 'timeout',
      responseStatus: 202,
    });

    const replayed = await fixture.repository.createPayment(cycle.command);
    expect(replayed.kind).toBe('replayed');
    if (replayed.kind !== 'replayed') {
      throw new Error('expected a replay');
    }
    // 202, not 201: a replayed uncertain payment must not look created.
    expect(replayed.responseStatus).toBe(202);
    expect(replayed.responseBody).toEqual({ id: 'pay_rendered', status: 'unknown' });
  });

  it('does not create a second payment on replay', async () => {
    const cycle = await runCycle({
      outcomeClass: 'success',
      toStatus: 'awaiting_payment',
      trigger: 'INSTRUMENT_ISSUED',
      evidenceClass: 'authenticated_provider_read',
      withProviderReference: true,
      responseStatus: 201,
    });

    await fixture.repository.createPayment(cycle.command);
    await fixture.repository.createPayment(cycle.command);

    const count = await fixture.ownerPool.query<{ count: string }>(
      'SELECT count(*) AS count FROM payments WHERE merchant_reference = $1',
      [cycle.command.merchantReference],
    );
    expect(Number(count.rows[0]?.count)).toBe(1);
    expect(await readAttempts(cycle.paymentId)).toHaveLength(1);
  });
});

describe('history is a complete, ordered account', () => {
  it('numbers every transition consecutively from the payment’s own sequence', async () => {
    const cycle = await runCycle({
      outcomeClass: 'success',
      toStatus: 'awaiting_payment',
      trigger: 'INSTRUMENT_ISSUED',
      evidenceClass: 'authenticated_provider_read',
      withProviderReference: true,
      responseStatus: 201,
    });

    const transitions = await readTransitions(cycle.paymentId);
    expect(transitions.map((row) => row.sequence_number)).toEqual(['1', '2']);
    // Each row starts where the previous one ended: no gaps, no invented origin.
    expect(transitions[1]?.from_status).toBe(transitions[0]?.to_status);
    const payment = await readPayment(cycle.paymentId);
    expect(payment.status_sequence).toBe(transitions.at(-1)?.sequence_number);
  });

  it('cannot be rewritten, even by the role that wrote it', async () => {
    const cycle = await runCycle({
      outcomeClass: 'success',
      toStatus: 'awaiting_payment',
      trigger: 'INSTRUMENT_ISSUED',
      evidenceClass: 'authenticated_provider_read',
      withProviderReference: true,
      responseStatus: 201,
    });

    const client = await fixture.applicationPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        fixture.merchant.id,
      ]);
      await expect(
        client.query('DELETE FROM payment_status_transitions WHERE payment_id = $1', [
          cycle.paymentId,
        ]),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    expect(await readTransitions(cycle.paymentId)).toHaveLength(2);
  });
});

describe('tenant isolation holds through the whole cycle', () => {
  it('hides one merchant’s payment from another, so it cannot even be addressed', async () => {
    const created = await claimPayment();

    const client = await fixture.applicationPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        fixture.otherMerchant.id,
      ]);
      const visible = await client.query('SELECT id FROM payments WHERE id = $1', [
        created.paymentId,
      ]);
      expect(visible.rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('lets two merchants use the same idempotency key independently', async () => {
    const sharedKey = `key-${publicIdentifierFor('k')}`;

    const mine = await fixture.repository.createPayment(
      commandFor({ idempotencyKey: sharedKey, organizationId: fixture.merchant.id }),
    );
    const theirs = await fixture.repository.createPayment(
      commandFor({ idempotencyKey: sharedKey, organizationId: fixture.otherMerchant.id }),
    );

    expect(mine.kind).toBe('created');
    expect(theirs.kind).toBe('created');
  });
});
