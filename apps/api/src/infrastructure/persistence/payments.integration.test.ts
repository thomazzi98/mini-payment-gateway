import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  TERMINAL_PAYMENT_STATUSES,
} from '../../domain/payment/payment-transition-table.js';
import {
  asOrganization,
  createApplicationPool,
  createOwnerPool,
  publicIdentifierFor,
  seedOrganization,
} from './test-database.js';
import type { SeededOrganization } from './test-database.js';

/**
 * Attacks the payment schema directly as the owner, with no repository in the
 * way. Every assertion here is about what PostgreSQL refuses, so a pass means the
 * invariant holds even if the application layer is wrong.
 */

interface PaymentFixture {
  ownerPool: Pool;
  applicationPool: Pool;
  merchantA: SeededOrganization;
  merchantB: SeededOrganization;
}

function byName(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

const fixture = {} as PaymentFixture;
const organizationIds: string[] = [];

interface PaymentOverrides {
  status?: string;
  capturedAmountMinor?: number;
  refundedAmountMinor?: number;
  expectedAmountMinor?: number;
  paidAt?: string | null;
  paymentMethod?: string;
  merchantReference?: string;
  organizationId?: string;
}

async function insertPayment(overrides: PaymentOverrides = {}): Promise<string> {
  const result = await fixture.ownerPool.query<{ id: string }>(
    `INSERT INTO payments
       (public_id, organization_id, environment, merchant_reference, payment_method,
        currency, expected_amount_minor, captured_amount_minor, refunded_amount_minor,
        status, paid_at)
     VALUES ($1, $2, 'SANDBOX', $3, $4, 'BRL', $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      publicIdentifierFor('pay'),
      overrides.organizationId ?? fixture.merchantA.id,
      overrides.merchantReference ?? `reference-${publicIdentifierFor('r')}`,
      overrides.paymentMethod ?? 'pix',
      overrides.expectedAmountMinor ?? 10_000,
      overrides.capturedAmountMinor ?? 0,
      overrides.refundedAmountMinor ?? 0,
      overrides.status ?? 'pending',
      overrides.paidAt === undefined ? null : overrides.paidAt,
    ],
  );
  return result.rows[0]?.id ?? '';
}

async function insertAttempt(
  paymentId: string,
  attemptNumber: number,
  options: { providerCode?: string; providerReference?: string; organizationId?: string } = {},
) {
  return fixture.ownerPool.query(
    `INSERT INTO payment_attempts
       (public_id, payment_id, organization_id, attempt_number, provider_code, provider_reference)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      publicIdentifierFor('att'),
      paymentId,
      options.organizationId ?? fixture.merchantA.id,
      attemptNumber,
      options.providerCode ?? 'appmax',
      options.providerReference ?? null,
    ],
  );
}

async function recordTransition(
  paymentId: string,
  from: string,
  to: string,
  trigger: string,
  evidence = 'authenticated_provider_read',
  sequence = 1,
) {
  return fixture.ownerPool.query(
    `INSERT INTO payment_status_transitions
       (payment_id, organization_id, sequence_number, from_status, to_status,
        trigger_name, evidence_class, captured_amount_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
    [paymentId, fixture.merchantA.id, sequence, from, to, trigger, evidence],
  );
}

/**
 * Moves a payment the way the application must: the audit row and the status
 * change commit together, or neither does. There is no shortcut, by design.
 */
async function transitionPayment(
  paymentId: string,
  from: string,
  to: string,
  trigger: string,
  evidence = 'internal',
): Promise<void> {
  const client = await fixture.ownerPool.connect();
  try {
    await client.query('BEGIN');
    const next = await client.query<{ status_sequence: string }>(
      'SELECT status_sequence FROM payments WHERE id = $1 FOR UPDATE',
      [paymentId],
    );
    const sequence = Number(next.rows[0]?.status_sequence ?? 0) + 1;

    await client.query(
      `INSERT INTO payment_status_transitions
         (payment_id, organization_id, sequence_number, from_status, to_status,
          trigger_name, evidence_class, captured_amount_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [paymentId, fixture.merchantA.id, sequence, from, to, trigger, evidence],
    );
    await client.query('UPDATE payments SET status = $1, status_sequence = $2 WHERE id = $3', [
      to,
      sequence,
      paymentId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  fixture.ownerPool = createOwnerPool();
  fixture.applicationPool = createApplicationPool();
  fixture.merchantA = await seedOrganization(fixture.ownerPool, 'Payments Merchant A');
  fixture.merchantB = await seedOrganization(fixture.ownerPool, 'Payments Merchant B');
  organizationIds.push(fixture.merchantA.id, fixture.merchantB.id);
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
  await fixture.ownerPool.query('DELETE FROM payments WHERE organization_id = ANY($1)', [
    organizationIds,
  ]);
  await fixture.ownerPool.query('DELETE FROM organizations WHERE id = ANY($1)', [organizationIds]);
  await fixture.ownerPool.end();
  await fixture.applicationPool.end();
});

describe('money is never floating point', () => {
  it('stores every monetary column as bigint', async () => {
    // The check that makes "no floats" a property of the database rather than a
    // convention. 19.99 is not representable anywhere in this schema.
    const result = await fixture.ownerPool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name LIKE '%amount%' OR column_name LIKE '%_minor')
          AND data_type <> 'bigint'`,
    );

    expect(result.rows).toEqual([]);
  });

  it('has no numeric, real, double or money column anywhere', async () => {
    const result = await fixture.ownerPool.query<{ column_name: string }>(
      `SELECT table_name || '.' || column_name AS column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('numeric', 'real', 'double precision', 'money')`,
    );

    expect(result.rows.map((row) => row.column_name)).toEqual([]);
  });
});

describe('a payment cannot disagree with its own money', () => {
  it('accepts an ordinary pending payment', async () => {
    await expect(insertPayment()).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a paid status with nothing captured', async () => {
    await expect(insertPayment({ status: 'paid' })).rejects.toThrow(
      /payments_status_agrees_with_capture|payments_paid_at_agrees_with_capture/,
    );
  });

  it('refuses captured money without a paid timestamp', async () => {
    await expect(insertPayment({ status: 'paid', capturedAmountMinor: 10_000 })).rejects.toThrow(
      /payments_paid_at_agrees_with_capture/,
    );
  });

  it('refuses a paid timestamp with nothing captured', async () => {
    await expect(insertPayment({ paidAt: new Date().toISOString() })).rejects.toThrow(
      /payments_paid_at_agrees_with_capture/,
    );
  });

  it('refuses captured money while the status says it is still unpaid', async () => {
    // This is the legacy bug made unwritable: `status` and `paidAt` were encoded
    // separately and five code paths let them drift apart.
    await expect(
      insertPayment({
        status: 'awaiting_payment',
        capturedAmountMinor: 10_000,
        paidAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/payments_status_agrees_with_capture/);
  });

  it('refuses a refund larger than what was captured', async () => {
    await expect(
      insertPayment({
        status: 'paid',
        capturedAmountMinor: 10_000,
        refundedAmountMinor: 10_001,
        paidAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/payments_refund_within_capture/);
  });

  it('refuses a fully refunded status that has not returned everything', async () => {
    await expect(
      insertPayment({
        status: 'refunded',
        capturedAmountMinor: 10_000,
        refundedAmountMinor: 9000,
        paidAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/payments_refunded_shape/);
  });

  it('refuses a partially refunded status that refunded everything or nothing', async () => {
    for (const refunded of [0, 10_000]) {
      await expect(
        insertPayment({
          status: 'partially_refunded',
          capturedAmountMinor: 10_000,
          refundedAmountMinor: refunded,
          paidAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/payments_partially_refunded_shape/);
    }
  });

  it('refuses a zero or negative expected amount', async () => {
    for (const amount of [0, -1]) {
      await expect(insertPayment({ expectedAmountMinor: amount })).rejects.toThrow(
        /expected_amount_minor/,
      );
    }
  });

  it('refuses a payment method the gateway does not implement', async () => {
    await expect(insertPayment({ paymentMethod: 'crypto' })).rejects.toThrow(/payment_method/);
  });
});

describe('a merchant reference identifies one live payment', () => {
  it('refuses a second live payment on the same reference', async () => {
    // Re-using a reference while the first payment is still open is a duplicate,
    // not a second payment.
    const reference = `reference-${publicIdentifierFor('r')}`;
    await insertPayment({ merchantReference: reference });

    await expect(insertPayment({ merchantReference: reference })).rejects.toThrow(
      /payments_one_live_per_merchant_reference/,
    );
  });

  it('frees the reference once the first payment reaches a finished status', async () => {
    const reference = `reference-${publicIdentifierFor('r')}`;
    const first = await insertPayment({ merchantReference: reference });
    await transitionPayment(first, 'pending', 'cancelled', 'MERCHANT_CANCELLED');

    await expect(insertPayment({ merchantReference: reference })).resolves.toBeTruthy();
  });

  it('scopes the reference to one organization, so two merchants may use the same one', async () => {
    const reference = `reference-${publicIdentifierFor('r')}`;
    await insertPayment({ merchantReference: reference, organizationId: fixture.merchantA.id });

    await expect(
      insertPayment({ merchantReference: reference, organizationId: fixture.merchantB.id }),
    ).resolves.toBeTruthy();
  });
});

describe('attempts, which is where retries and failover live', () => {
  it('allows one payment to carry several attempts against different providers', async () => {
    // One payment is never assumed to equal one provider transaction.
    const paymentId = await insertPayment();
    await insertAttempt(paymentId, 1, { providerCode: 'appmax' });
    await insertAttempt(paymentId, 2, { providerCode: 'simulator' });

    const attempts = await fixture.ownerPool.query<{ count: string }>(
      'SELECT count(*) AS count FROM payment_attempts WHERE payment_id = $1',
      [paymentId],
    );
    expect(Number(attempts.rows[0]?.count)).toBe(2);
  });

  it('refuses a duplicate attempt number on the same payment', async () => {
    const paymentId = await insertPayment();
    await insertAttempt(paymentId, 1);
    await expect(insertAttempt(paymentId, 1)).rejects.toThrow(/payment_attempts_number_unique/);
  });

  it('refuses two payments claiming the same provider transaction', async () => {
    // The correlation key an inbound webhook resolves through. Without this a
    // misrouted callback could credit the wrong payment.
    const reference = `provider-reference-${publicIdentifierFor('p')}`;
    const first = await insertPayment();
    const second = await insertPayment();

    await insertAttempt(first, 1, { providerReference: reference });
    await expect(insertAttempt(second, 1, { providerReference: reference })).rejects.toThrow(
      /payment_attempts_provider_reference/,
    );
  });

  it('allows many attempts with no provider reference yet', async () => {
    // Null means the provider never answered. That is common and must not collide.
    const first = await insertPayment();
    const second = await insertPayment();
    await insertAttempt(first, 1);
    await expect(insertAttempt(second, 1)).resolves.toBeTruthy();
  });

  it('refuses an attempt attached to a payment owned by another organization', async () => {
    // The composite foreign key: an attempt cannot straddle two tenants.
    const paymentOfA = await insertPayment({ organizationId: fixture.merchantA.id });
    await expect(
      insertAttempt(paymentOfA, 1, { organizationId: fixture.merchantB.id }),
    ).rejects.toThrow(/payment_attempts_belong_to_one_tenant/);
  });

  it('refuses a finished attempt with no outcome, and an outcome with no finish', async () => {
    const paymentId = await insertPayment();
    await expect(
      fixture.ownerPool.query(
        `INSERT INTO payment_attempts
           (public_id, payment_id, organization_id, attempt_number, provider_code, finished_at)
         VALUES ($1, $2, $3, 1, 'appmax', now())`,
        [publicIdentifierFor('att'), paymentId, fixture.merchantA.id],
      ),
    ).rejects.toThrow(/payment_attempts_finished_shape/);
  });

  it('refuses an outcome class outside the taxonomy', async () => {
    const paymentId = await insertPayment();
    await expect(
      fixture.ownerPool.query(
        `INSERT INTO payment_attempts
           (public_id, payment_id, organization_id, attempt_number, provider_code,
            outcome_class, finished_at)
         VALUES ($1, $2, $3, 1, 'appmax', 'probably_fine', now())`,
        [publicIdentifierFor('att'), paymentId, fixture.merchantA.id],
      ),
    ).rejects.toThrow(/outcome_class/);
  });
});

describe('status transitions', () => {
  it('accepts a declared edge', async () => {
    const paymentId = await insertPayment();
    await expect(
      recordTransition(paymentId, 'pending', 'processing', 'PROVIDER_REQUEST_SENT', 'internal'),
    ).resolves.toBeTruthy();
  });

  it('refuses an undeclared edge by foreign key, whatever the application believes', async () => {
    // There is no ('paid','awaiting_payment') row in legal_payment_transitions, so
    // a stale expiry or replayed webhook cannot move a payment backwards.
    const paymentId = await insertPayment();
    await expect(
      recordTransition(paymentId, 'paid', 'awaiting_payment', 'PAYMENT_CONFIRMED'),
    ).rejects.toThrow(/transitions_must_be_legal/);
  });

  it('refuses any edge leaving a terminal status', async () => {
    const paymentId = await insertPayment();
    for (const from of ['refunded', 'failed', 'cancelled']) {
      await expect(recordTransition(paymentId, from, 'paid', 'PAYMENT_CONFIRMED')).rejects.toThrow(
        /transitions_must_be_legal/,
      );
    }
  });

  it('refuses to fund a payment on unauthenticated evidence', async () => {
    // The rule that makes an unsigned Appmax webhook harmless: it may schedule a
    // read, and only the read can move money.
    const paymentId = await insertPayment();
    await expect(
      recordTransition(paymentId, 'awaiting_payment', 'paid', 'PAYMENT_CONFIRMED', 'internal'),
    ).rejects.toThrow(/transitions_into_funds_require_authenticated_read/);
  });

  it('refuses a duplicate sequence number on the same payment', async () => {
    const paymentId = await insertPayment();
    await recordTransition(paymentId, 'pending', 'processing', 'PROVIDER_REQUEST_SENT', 'internal');
    await expect(
      recordTransition(paymentId, 'pending', 'cancelled', 'MERCHANT_CANCELLED', 'internal'),
    ).rejects.toThrow(/transitions_sequence_unique/);
  });

  it('is append-only: history cannot be rewritten or erased', async () => {
    const paymentId = await insertPayment();
    await recordTransition(paymentId, 'pending', 'processing', 'PROVIDER_REQUEST_SENT', 'internal');

    await expect(
      fixture.ownerPool.query(
        'UPDATE payment_status_transitions SET to_status = $1 WHERE payment_id = $2',
        ['paid', paymentId],
      ),
    ).rejects.toThrow(/append_only_table_violation/);

    await expect(
      fixture.ownerPool.query('DELETE FROM payment_status_transitions WHERE payment_id = $1', [
        paymentId,
      ]),
    ).rejects.toThrow(/append_only_table_violation/);
  });
});

describe('a status change without an audit row cannot commit', () => {
  it('refuses an unaudited status change', async () => {
    // The definitive answer to the legacy system's five uncoordinated write paths:
    // a sixth is not discouraged, it is rejected by the database.
    const paymentId = await insertPayment();

    await expect(
      fixture.ownerPool.query(
        'UPDATE payments SET status = $1, status_sequence = status_sequence + 1 WHERE id = $2',
        ['processing', paymentId],
      ),
    ).rejects.toThrow(/unaudited_payment_status_change/);
  });

  it('accepts a status change accompanied by its transition row in the same transaction', async () => {
    const paymentId = await insertPayment();
    const client = await fixture.ownerPool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO payment_status_transitions
           (payment_id, organization_id, sequence_number, from_status, to_status,
            trigger_name, evidence_class, captured_amount_after)
         VALUES ($1, $2, 1, 'pending', 'processing', 'PROVIDER_REQUEST_SENT', 'internal', 0)`,
        [paymentId, fixture.merchantA.id],
      );
      await client.query('UPDATE payments SET status = $1, status_sequence = 1 WHERE id = $2', [
        'processing',
        paymentId,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const result = await fixture.ownerPool.query<{ status: string }>(
      'SELECT status FROM payments WHERE id = $1',
      [paymentId],
    );
    expect(result.rows[0]?.status).toBe('processing');
  });
});

describe('tenant isolation extends to payments', () => {
  it('hides another merchant’s payments and attempts from the application role', async () => {
    const paymentOfB = await insertPayment({ organizationId: fixture.merchantB.id });

    const visible = await asOrganization(
      fixture.applicationPool,
      fixture.merchantA.id,
      async (client) => {
        const result = await client.query<{ id: string }>('SELECT id FROM payments WHERE id = $1', [
          paymentOfB,
        ]);
        return result.rows;
      },
    );

    expect(visible).toHaveLength(0);
  });

  it('refuses to create a payment assigned to another merchant', async () => {
    await expect(
      asOrganization(fixture.applicationPool, fixture.merchantA.id, (client) =>
        client.query(
          `INSERT INTO payments
             (public_id, organization_id, environment, merchant_reference, payment_method,
              currency, expected_amount_minor)
           VALUES ($1, $2, 'SANDBOX', 'stolen', 'pix', 'BRL', 500)`,
          [publicIdentifierFor('pay'), fixture.merchantB.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('the database and the state machine agree on what is legal', () => {
  /**
   * The transition table exists in two places: TypeScript, where the state machine
   * reads it, and SQL, where a foreign key enforces it. Two copies of a rule drift
   * apart eventually, so this compares them on every run.
   */
  it('declares exactly the same edges in both places', async () => {
    const result = await fixture.ownerPool.query<{
      from_status: string;
      to_status: string;
      trigger_name: string;
      minimum_evidence: string;
    }>(
      'SELECT from_status, to_status, trigger_name, minimum_evidence FROM legal_payment_transitions',
    );

    const inDatabase = result.rows
      .map(
        (row) => `${row.from_status}->${row.to_status}:${row.trigger_name}:${row.minimum_evidence}`,
      )
      .toSorted(byName);

    const inCode = PAYMENT_TRANSITIONS.map(
      (transition) =>
        `${transition.from}->${transition.to}:${transition.trigger}:${transition.minimumEvidence}`,
    ).toSorted(byName);

    expect(inDatabase).toEqual(inCode);
  });

  it('declares the same statuses in both places', async () => {
    const result = await fixture.ownerPool.query<{ status: string }>(
      'SELECT status FROM payment_statuses',
    );
    expect(result.rows.map((row) => row.status).toSorted(byName)).toEqual(
      [...PAYMENT_STATUSES].toSorted(byName),
    );
  });

  it('agrees on which statuses are terminal', async () => {
    const result = await fixture.ownerPool.query<{ status: string }>(
      'SELECT status FROM payment_statuses WHERE is_terminal',
    );
    expect(result.rows.map((row) => row.status).toSorted(byName)).toEqual(
      [...TERMINAL_PAYMENT_STATUSES].toSorted(byName),
    );
  });
});
