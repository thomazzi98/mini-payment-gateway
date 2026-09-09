import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentCreationRepository } from './payment-creation.repository.js';
import type { CreatePaymentCommand, CreatePaymentResult } from './payment-creation.repository.js';
import {
  asOrganization,
  createApplicationPool,
  createOwnerPool,
  publicIdentifierFor,
  seedOrganization,
} from './test-database.js';
import type { SeededOrganization } from './test-database.js';

/**
 * The property under test is not "we check for duplicates" but "the database
 * permits only one claim". These run real concurrent transactions against real
 * PostgreSQL, because a single-threaded test cannot observe the race that matters.
 */

interface IdempotencyFixture {
  ownerPool: Pool;
  applicationPool: Pool;
  repository: PaymentCreationRepository;
  merchantA: SeededOrganization;
  merchantB: SeededOrganization;
}

const fixture = {} as IdempotencyFixture;
const organizationIds: string[] = [];

function commandFor(overrides: Partial<CreatePaymentCommand> = {}): CreatePaymentCommand {
  const reference = `reference-${publicIdentifierFor('r')}`;
  return {
    organizationId: fixture.merchantA.id,
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

async function countPaymentsWithReference(reference: string): Promise<number> {
  const result = await fixture.ownerPool.query<{ count: string }>(
    'SELECT count(*) AS count FROM payments WHERE merchant_reference = $1',
    [reference],
  );
  return Number(result.rows[0]?.count ?? 0);
}

beforeAll(async () => {
  fixture.ownerPool = createOwnerPool();
  fixture.applicationPool = createApplicationPool();
  fixture.repository = new PaymentCreationRepository(fixture.applicationPool);
  fixture.merchantA = await seedOrganization(fixture.ownerPool, 'Idempotency Merchant A');
  fixture.merchantB = await seedOrganization(fixture.ownerPool, 'Idempotency Merchant B');
  organizationIds.push(fixture.merchantA.id, fixture.merchantB.id);
});

afterAll(async () => {
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

describe('creating a payment once', () => {
  it('creates it and returns a public identifier', async () => {
    const result = await fixture.repository.createPayment(commandFor());

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') {
      throw new Error('expected the payment to be created');
    }
    expect(result.publicId).toMatch(/^pay_[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it('records the idempotency key as completed alongside the payment', async () => {
    const command = commandFor();
    await fixture.repository.createPayment(command);

    const record = await fixture.ownerPool.query<{
      state: string;
      response_status: number;
      payment_id: string | null;
    }>(
      `SELECT state, response_status, payment_id FROM idempotency_records
        WHERE organization_id = $1 AND idempotency_key = $2`,
      [command.organizationId, command.idempotencyKey],
    );

    expect(record.rows[0]?.state).toBe('completed');
    expect(record.rows[0]?.response_status).toBe(201);
    expect(record.rows[0]?.payment_id).not.toBeNull();
  });
});

describe('repeating the same key', () => {
  it('replays the original response instead of creating a second payment', async () => {
    const command = commandFor();
    const first = await fixture.repository.createPayment(command);
    const second = await fixture.repository.createPayment(command);

    expect(second.kind).toBe('replayed');
    if (second.kind !== 'replayed' || first.kind !== 'created') {
      throw new Error('expected a create followed by a replay');
    }
    expect(second.responseStatus).toBe(201);
    expect(second.responseBody).toEqual({ id: first.publicId, status: 'pending' });
    expect(await countPaymentsWithReference(command.merchantReference)).toBe(1);
  });

  it('replays identically however many times it is retried', async () => {
    const command = commandFor();
    await fixture.repository.createPayment(command);

    const replays = await Promise.all(
      Array.from({ length: 10 }, async () => fixture.repository.createPayment(command)),
    );

    expect(replays.every((replay) => replay.kind === 'replayed')).toBe(true);
    expect(await countPaymentsWithReference(command.merchantReference)).toBe(1);
  });

  it('refuses the same key carrying a different amount', async () => {
    // A caller bug, not a retry. Returning the first response would charge them
    // for something they did not ask for.
    const command = commandFor();
    await fixture.repository.createPayment(command);

    const conflicting = await fixture.repository.createPayment({
      ...command,
      merchantReference: `reference-${publicIdentifierFor('r')}`,
      expectedAmountMinor: 99_999n,
      requestBody: { amount: 99_999, currency: 'BRL' },
    });

    expect(conflicting.kind).toBe('conflict');
    expect(await countPaymentsWithReference(command.merchantReference)).toBe(1);
  });

  it('refuses the same key used on a different endpoint', async () => {
    const command = commandFor();
    await fixture.repository.createPayment(command);

    const conflicting = await fixture.repository.createPayment({
      ...command,
      merchantReference: `reference-${publicIdentifierFor('r')}`,
      requestPath: '/v1/refunds',
    });

    expect(conflicting.kind).toBe('conflict');
  });
});

describe('concurrent requests carrying the same key', () => {
  it('creates exactly one payment when fifty requests race', async () => {
    // The assertion the whole mechanism exists for. Fifty transactions reach the
    // insert together; the unique index decides, and forty-nine are told what the
    // winner did.
    const command = commandFor();

    const results = await Promise.all(
      Array.from({ length: 50 }, async () => fixture.repository.createPayment(command)),
    );

    const created = results.filter((result) => result.kind === 'created');
    const handled = results.filter(
      (result) => result.kind === 'replayed' || result.kind === 'in_flight',
    );

    expect(created).toHaveLength(1);
    expect(handled).toHaveLength(49);
    expect(await countPaymentsWithReference(command.merchantReference)).toBe(1);
  });

  it('creates exactly one payment even when the racers are told to conflict', async () => {
    // Same key, different bodies, all at once. Whatever the interleaving, at most
    // one payment may exist and nobody may be silently given the other's result.
    const key = `key-${publicIdentifierFor('k')}`;
    const commands = Array.from({ length: 20 }, (_, index) =>
      commandFor({
        idempotencyKey: key,
        expectedAmountMinor: BigInt(1000 + index),
        requestBody: { amount: 1000 + index },
      }),
    );

    const results = await Promise.all(
      commands.map(async (command) => fixture.repository.createPayment(command)),
    );

    const created = results.filter((result) => result.kind === 'created');
    expect(created).toHaveLength(1);

    const paymentsForKey = await fixture.ownerPool.query<{ count: string }>(
      `SELECT count(*) AS count FROM payments
        WHERE id = (SELECT payment_id FROM idempotency_records
                     WHERE organization_id = $1 AND idempotency_key = $2)`,
      [fixture.merchantA.id, key],
    );
    expect(Number(paymentsForKey.rows[0]?.count)).toBe(1);
  });

  it('never records more than one idempotency row for a key', async () => {
    const command = commandFor();
    await Promise.all(
      Array.from({ length: 30 }, async () => fixture.repository.createPayment(command)),
    );

    const rows = await fixture.ownerPool.query<{ count: string }>(
      `SELECT count(*) AS count FROM idempotency_records
        WHERE organization_id = $1 AND idempotency_key = $2`,
      [command.organizationId, command.idempotencyKey],
    );
    expect(Number(rows.rows[0]?.count)).toBe(1);
  });
});

describe('the key is scoped to its tenant and environment', () => {
  it('lets two merchants use the same key text independently', async () => {
    const key = `key-${publicIdentifierFor('k')}`;

    const forA = await fixture.repository.createPayment(
      commandFor({ idempotencyKey: key, organizationId: fixture.merchantA.id }),
    );
    const forB = await fixture.repository.createPayment(
      commandFor({ idempotencyKey: key, organizationId: fixture.merchantB.id }),
    );

    expect(forA.kind).toBe('created');
    expect(forB.kind).toBe('created');
  });

  it('does not let one merchant replay another merchant’s key', async () => {
    // Otherwise a merchant could learn what another merchant created simply by
    // guessing a key.
    const key = `key-${publicIdentifierFor('k')}`;
    await fixture.repository.createPayment(
      commandFor({ idempotencyKey: key, organizationId: fixture.merchantA.id }),
    );

    const forB = await fixture.repository.createPayment(
      commandFor({ idempotencyKey: key, organizationId: fixture.merchantB.id }),
    );

    expect(forB.kind).toBe('created');
  });

  it('separates sandbox from production under the same key', async () => {
    const key = `key-${publicIdentifierFor('k')}`;
    await fixture.ownerPool.query(
      'UPDATE organizations SET is_production_enabled = TRUE WHERE id = $1',
      [fixture.merchantA.id],
    );

    const sandbox = await fixture.repository.createPayment(
      commandFor({ idempotencyKey: key, environment: 'SANDBOX' }),
    );
    const production = await fixture.repository.createPayment(
      commandFor({ idempotencyKey: key, environment: 'PRODUCTION' }),
    );

    expect(sandbox.kind).toBe('created');
    expect(production.kind).toBe('created');
  });

  it('keeps idempotency records invisible across tenants', async () => {
    const command = commandFor({ organizationId: fixture.merchantA.id });
    await fixture.repository.createPayment(command);

    const visibleToB = await asOrganization(
      fixture.applicationPool,
      fixture.merchantB.id,
      async (client) => {
        const result = await client.query<{ id: string }>(
          'SELECT id FROM idempotency_records WHERE idempotency_key = $1',
          [command.idempotencyKey],
        );
        return result.rows;
      },
    );

    expect(visibleToB).toHaveLength(0);
  });
});

describe('a distinct key is still bounded by the merchant reference', () => {
  it('refuses a second live payment on the same reference under a different key', async () => {
    // Idempotency keys stop accidental retries. The merchant reference stops a
    // deliberate duplicate that carries a fresh key.
    const command = commandFor();
    const first = await fixture.repository.createPayment(command);
    expect(first.kind).toBe('created');

    const second: CreatePaymentResult = await fixture.repository.createPayment({
      ...command,
      idempotencyKey: `key-${publicIdentifierFor('k')}`,
    });

    expect(second.kind).toBe('duplicate_merchant_reference');
    expect(await countPaymentsWithReference(command.merchantReference)).toBe(1);
  });
});
