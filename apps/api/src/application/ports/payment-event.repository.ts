/**
 * What delivering the paid event needs from storage.
 *
 * Claiming is by lease, exactly as reconciliation claims payments: a worker takes
 * a batch, releases its transaction, makes the HTTP call, and comes back. A
 * worker that dies mid-delivery delays its events by one lease and loses none.
 */

export interface DeliverablePaymentEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly eventType: string;
  /**
   * The body as written when the payment was funded. Read as `unknown` here and
   * decoded by the use case, so a payload shape this code does not recognise is
   * refused rather than half-delivered.
   */
  readonly payload: unknown;
  readonly occurredAt: Date;
  /**
   * Including the claim that returned this row.
   */
  readonly attempts: number;
}

export interface PaymentEventStore {
  claimDue(limit: number, leaseSeconds: number): Promise<DeliverablePaymentEvent[]>;

  markDelivered(command: {
    readonly eventId: string;
    readonly organizationId: string;
    /**
     * The notification service's identifier for what it accepted.
     */
    readonly reference: string;
  }): Promise<void>;

  /**
   * Nobody could be told, and nothing will change that. Closed rather than
   * retried, so an event with no recipient does not occupy the queue forever.
   */
  markSkipped(command: {
    readonly eventId: string;
    readonly organizationId: string;
    readonly reason: string;
  }): Promise<void>;

  defer(command: {
    readonly eventId: string;
    readonly organizationId: string;
    readonly dueAt: Date;
    readonly failure: string;
  }): Promise<void>;

  abandon(command: {
    readonly eventId: string;
    readonly organizationId: string;
    readonly failure: string;
  }): Promise<void>;
}
