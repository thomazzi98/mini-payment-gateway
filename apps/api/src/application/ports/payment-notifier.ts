/**
 * The seam the paid event leaves the gateway through.
 *
 * The notification service is another system with its own delivery guarantees;
 * what the gateway asks of it is that a message be accepted durably, once per
 * event. The event id travels as the idempotency key, so handing the same event
 * over twice — after a timeout, after a restart — yields one message.
 */

export interface PaidNotification {
  readonly eventId: string;
  /**
   * E.164, as the payment recorded it.
   */
  readonly recipient: string;
  readonly message: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export type NotificationOutcome =
  /**
  Accepted durably. `reference` is the service's identifier for the notification.
  */
  | { readonly kind: 'accepted'; readonly reference: string }
  /**
  Not accepted, and asking again later may succeed.
  */
  | { readonly kind: 'retry'; readonly reason: string }
  /**
  Refused in a way that will not change: a recipient the service will not take,
  a credential it does not recognise. Retrying would fail the same way.
  */
  | { readonly kind: 'refused'; readonly reason: string };

export interface PaymentPaidNotifier {
  notify(notification: PaidNotification): Promise<NotificationOutcome>;
}
