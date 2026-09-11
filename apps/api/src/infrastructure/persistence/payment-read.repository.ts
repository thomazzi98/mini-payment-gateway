import type { Pool, PoolClient } from 'pg';
import type { PresentedInstrument } from '../../application/create-payment.use-case.js';
import type {
  PaymentReadStore,
  PaymentSnapshot,
} from '../../application/ports/payment-read.repository.js';

/**
 * Reads one payment and its three histories, inside one tenant-scoped
 * transaction so row-level security applies to every table touched and the
 * histories describe the same moment as the payment row.
 */

interface PaymentRow {
  readonly id: string;
  readonly public_id: string;
  readonly status: string;
  readonly payment_method: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly currency: string;
  readonly expected_amount_minor: string;
  readonly captured_amount_minor: string;
  readonly merchant_reference: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly expires_at: Date | null;
  readonly paid_at: Date | null;
}

interface AttemptRow {
  readonly provider_code: string;
  readonly provider_reference: string | null;
  readonly instrument: PresentedInstrument | null;
}

export class PaymentReadRepository implements PaymentReadStore {
  public constructor(private readonly pool: Pool) {}

  private async read(
    client: PoolClient,
    query: {
      readonly organizationId: string;
      readonly environment: 'SANDBOX' | 'PRODUCTION';
      readonly publicId: string;
    },
  ): Promise<PaymentSnapshot | undefined> {
    const payment = await client.query<PaymentRow>(
      `SELECT id, public_id, status, payment_method, environment, currency,
              expected_amount_minor, captured_amount_minor, merchant_reference,
              created_at, updated_at, expires_at, paid_at
         FROM payments
        WHERE organization_id = $1 AND environment = $2 AND public_id = $3`,
      [query.organizationId, query.environment, query.publicId],
    );
    const row = payment.rows[0];
    if (row === undefined) {
      return undefined;
    }

    // The latest attempt is the one whose instrument the customer holds and
    // whose reference the provider knows the payment by.
    const attempt = await client.query<AttemptRow>(
      `SELECT provider_code, provider_reference, instrument
         FROM payment_attempts
        WHERE payment_id = $1
        ORDER BY attempt_number DESC
        LIMIT 1`,
      [row.id],
    );
    const latestAttempt = attempt.rows[0];

    const transitions = await client.query<{
      sequence_number: string;
      from_status: string;
      to_status: string;
      trigger_name: string;
      evidence_class: string;
      reason: string | null;
      occurred_at: Date;
    }>(
      `SELECT sequence_number, from_status, to_status, trigger_name, evidence_class, reason,
              occurred_at
         FROM payment_status_transitions
        WHERE payment_id = $1
        ORDER BY sequence_number`,
      [row.id],
    );

    const notifications = await client.query<{
      provider_code: string;
      event_type: string;
      received_at: Date;
      disposition: string;
    }>(
      `SELECT provider_code, event_type, received_at, disposition
         FROM provider_webhook_events
        WHERE payment_id = $1
        ORDER BY received_at`,
      [row.id],
    );

    const events = await client.query<{
      event_type: string;
      occurred_at: Date;
      delivery_status: string;
      delivery_reference: string | null;
      attempts: number;
      published_at: Date | null;
      last_failure: string | null;
    }>(
      `SELECT event_type, occurred_at, delivery_status, delivery_reference, attempts,
              published_at, last_failure
         FROM payment_events
        WHERE payment_id = $1
        ORDER BY occurred_at`,
      [row.id],
    );

    return {
      publicId: row.public_id,
      status: row.status,
      paymentMethod: row.payment_method,
      environment: row.environment,
      currency: row.currency,
      expectedAmountMinor: BigInt(row.expected_amount_minor),
      capturedAmountMinor: BigInt(row.captured_amount_minor),
      merchantReference: row.merchant_reference,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at ?? undefined,
      paidAt: row.paid_at ?? undefined,
      providerCode: latestAttempt?.provider_code,
      providerReference: latestAttempt?.provider_reference ?? undefined,
      instrument: latestAttempt?.instrument ?? undefined,
      transitions: transitions.rows.map((transition) => ({
        sequence: Number(transition.sequence_number),
        fromStatus: transition.from_status,
        toStatus: transition.to_status,
        trigger: transition.trigger_name,
        evidenceClass: transition.evidence_class,
        reason: transition.reason ?? undefined,
        occurredAt: transition.occurred_at,
      })),
      providerNotifications: notifications.rows.map((notification) => ({
        provider: notification.provider_code,
        eventType: notification.event_type,
        receivedAt: notification.received_at,
        disposition: notification.disposition,
      })),
      events: events.rows.map((event) => ({
        type: event.event_type,
        occurredAt: event.occurred_at,
        deliveryStatus: event.delivery_status,
        deliveryReference: event.delivery_reference ?? undefined,
        attempts: event.attempts,
        publishedAt: event.published_at ?? undefined,
        lastFailure: event.last_failure ?? undefined,
      })),
    };
  }

  public async findByPublicId(query: {
    readonly organizationId: string;
    readonly environment: 'SANDBOX' | 'PRODUCTION';
    readonly publicId: string;
  }): Promise<PaymentSnapshot | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        query.organizationId,
      ]);
      const snapshot = await this.read(client, query);
      await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
