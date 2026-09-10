import type { Pool } from 'pg';
import type {
  MatchedPayment,
  WebhookIngestionStore,
} from '../../application/ports/provider-webhook.repository.js';

/**
 * Storage for inbound provider notifications.
 *
 * Resolution happens without a tenant scope, because a notification arrives
 * before any tenant is known — the reference is what identifies the merchant, not
 * the other way round. The lookup returns one payment or nothing, and every write
 * that follows is scoped to the organization it returned.
 */
export class ProviderWebhookRepository implements WebhookIngestionStore {
  public constructor(private readonly pool: Pool) {}

  public async findPaymentByProviderReference(
    providerCode: string,
    providerReference: string,
  ): Promise<MatchedPayment | undefined> {
    const found = await this.pool.query<{ payment_id: string; organization_id: string }>(
      'SELECT payment_id, organization_id FROM find_payment_by_provider_reference($1, $2)',
      [providerCode, providerReference],
    );

    const row = found.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return { paymentId: row.payment_id, organizationId: row.organization_id };
  }

  public async recordEvent(event: {
    readonly providerCode: string;
    readonly providerEventId: string;
    readonly eventType: string;
    readonly providerReference: string | undefined;
    readonly paymentId: string | undefined;
    readonly organizationId: string | undefined;
    readonly disposition: 'scheduled_read' | 'unmatched' | 'ignored';
  }): Promise<'recorded' | 'duplicate'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Scoped once the payment is known, because row level security applies to
      // this table too: an event that names a payment may only be written by the
      // tenant that owns it. An unmatched event names no payment and needs no
      // scope, which is what the policy's own condition says.
      if (event.organizationId !== undefined) {
        await client.query('SELECT set_config($1, $2, true)', [
          'app.organization_id',
          event.organizationId,
        ]);
      }

      // ON CONFLICT DO NOTHING against the unique delivery index. Redelivery is
      // the norm rather than an anomaly, so it resolves to a no-op here instead
      // of becoming an error the route has to interpret.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO provider_webhook_events
           (provider_code, provider_event_id, event_type, provider_reference, payment_id, disposition)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (provider_code, provider_event_id) DO NOTHING
         RETURNING id`,
        [
          event.providerCode,
          event.providerEventId,
          event.eventType,
          event.providerReference ?? null,
          event.paymentId ?? null,
          event.disposition,
        ],
      );

      await client.query('COMMIT');
      return inserted.rows.length > 0 ? 'recorded' : 'duplicate';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async bringInquiryForward(paymentId: string, organizationId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        organizationId,
      ]);
      // Only a payment that is actually being observed, and only ever earlier.
      // A notification about a settled payment changes nothing, and one that
      // arrives while an inquiry is already leased must not cut that lease short.
      await client.query(
        `UPDATE payments
            SET reconciliation_due_at = now()
          WHERE id = $1
            AND status IN ('unknown', 'awaiting_payment')
            AND reconciliation_due_at IS NOT NULL
            AND reconciliation_due_at > now()`,
        [paymentId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
