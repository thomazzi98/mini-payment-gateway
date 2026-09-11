import type { Pool } from 'pg';
import type {
  DeliverablePaymentEvent,
  PaymentEventStore,
} from '../../application/ports/payment-event.repository.js';

/**
 * The outbox, read and closed.
 *
 * Claiming crosses tenants through one SECURITY DEFINER function, exactly as
 * reconciliation does; every write that follows sets the organization first, so
 * row-level security applies to it.
 */
export class PaymentEventRepository implements PaymentEventStore {
  public constructor(private readonly pool: Pool) {}

  private async write(
    organizationId: string,
    statement: string,
    parameters: readonly unknown[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        organizationId,
      ]);
      await client.query(statement, [...parameters]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimDue(limit: number, leaseSeconds: number): Promise<DeliverablePaymentEvent[]> {
    const result = await this.pool.query<{
      id: string;
      organization_id: string;
      event_type: string;
      payload: unknown;
      occurred_at: Date;
      attempts: number;
    }>('SELECT * FROM claim_payment_events_for_delivery($1, $2)', [limit, leaseSeconds]);

    return result.rows.map((row) => ({
      eventId: row.id,
      organizationId: row.organization_id,
      eventType: row.event_type,
      payload: row.payload,
      occurredAt: row.occurred_at,
      attempts: row.attempts,
    }));
  }

  public async markDelivered(command: {
    readonly eventId: string;
    readonly organizationId: string;
    readonly reference: string;
  }): Promise<void> {
    await this.write(
      command.organizationId,
      `UPDATE payment_events
          SET delivery_status = 'delivered', delivery_reference = $2, published_at = now(),
              last_failure = NULL
        WHERE id = $1 AND delivery_status = 'pending'`,
      [command.eventId, command.reference],
    );
  }

  public async markSkipped(command: {
    readonly eventId: string;
    readonly organizationId: string;
    readonly reason: string;
  }): Promise<void> {
    await this.write(
      command.organizationId,
      `UPDATE payment_events
          SET delivery_status = 'skipped', published_at = now(), last_failure = $2
        WHERE id = $1 AND delivery_status = 'pending'`,
      [command.eventId, command.reason],
    );
  }

  public async defer(command: {
    readonly eventId: string;
    readonly organizationId: string;
    readonly dueAt: Date;
    readonly failure: string;
  }): Promise<void> {
    await this.write(
      command.organizationId,
      `UPDATE payment_events
          SET next_attempt_at = $2, last_failure = $3
        WHERE id = $1 AND delivery_status = 'pending'`,
      [command.eventId, command.dueAt, command.failure],
    );
  }

  public async abandon(command: {
    readonly eventId: string;
    readonly organizationId: string;
    readonly failure: string;
  }): Promise<void> {
    await this.write(
      command.organizationId,
      `UPDATE payment_events
          SET delivery_status = 'abandoned', published_at = now(), last_failure = $2
        WHERE id = $1 AND delivery_status = 'pending'`,
      [command.eventId, command.failure],
    );
  }

  /**
   * How many events delivery has given up on. The operator backlog for this
   * queue, and worth reporting at startup for the same reason reconciliation
   * reports its own.
   */
  public async countAbandoned(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      'SELECT count_payment_events_abandoned() AS count',
    );
    return Number(result.rows[0]?.count ?? '0');
  }
}
