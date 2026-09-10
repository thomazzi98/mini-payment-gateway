import type { ProviderWebhookReceiver } from './ports/provider-webhook.js';
import type { WebhookIngestionStore } from './ports/provider-webhook.repository.js';

/**
 * Taking in a provider notification.
 *
 * The shape that matters: this never decides anything about money. It records
 * that a provider said something, finds the payment the provider was talking
 * about, and brings that payment's next inquiry forward. The inquiry — an
 * authenticated read, through the provider abstraction — decides.
 *
 * That is not caution for its own sake. Appmax sends no signature, so a
 * notification is an unauthenticated claim by anyone who can reach the endpoint.
 * Treating it as a prompt makes forgery worthless: the worst a forged
 * notification achieves is one provider call the payment would have made anyway.
 *
 * It also has to be fast. Appmax expects an answer within five seconds and
 * abandons delivery after four attempts, so the work here is two writes and no
 * network call.
 */

export type WebhookOutcome =
  /**
  Recorded, and the payment's next inquiry brought forward.
  */
  | { readonly kind: 'scheduled_read'; readonly paymentId: string }
  /**
  Seen before. The same answer as the first time, and no second effect.
  */
  | { readonly kind: 'duplicate' }
  /**
  Recorded, but nothing here recognises what it refers to.
  */
  | { readonly kind: 'unmatched' }
  /**
  Recorded, and known not to change anything.
  */
  | { readonly kind: 'ignored' }
  /**
  Not something this provider sends.
  */
  | { readonly kind: 'unreadable'; readonly reason: string };

export interface WebhookIngestionDependencies {
  readonly receiver: ProviderWebhookReceiver;
  readonly store: WebhookIngestionStore;
}

export async function ingestProviderWebhook(
  rawBody: Buffer,
  headers: Readonly<Record<string, string | undefined>>,
  dependencies: WebhookIngestionDependencies,
): Promise<WebhookOutcome> {
  // Against the bytes as received. A signature covers what was sent, not what a
  // parser reconstructed, so verification happens before anything is read.
  if (!dependencies.receiver.verify(rawBody, headers)) {
    return { kind: 'unreadable', reason: 'The notification could not be authenticated.' };
  }

  const parsed = dependencies.receiver.parse(rawBody);
  if (parsed.kind === 'unreadable') {
    return { kind: 'unreadable', reason: parsed.reason };
  }

  const event = parsed.event;

  // Resolved through the attempt that recorded this provider reference, which is
  // what ties the notification to one payment of one merchant. A notification
  // naming a reference nobody holds matches nothing and changes nothing; it
  // cannot be pointed at another merchant's payment, because the reference is
  // where ownership comes from.
  const payment =
    event.providerReference === undefined
      ? undefined
      : await dependencies.store.findPaymentByProviderReference(
          dependencies.receiver.providerCode,
          event.providerReference,
        );

  const disposition = dispositionFor(event.requiresRead, payment !== undefined);

  // The unique index on (provider, event id) is what makes redelivery a no-op.
  // At-least-once is the norm, so this is the ordinary path rather than an edge
  // case, and it is the database that decides it rather than any in-memory state
  // that would not survive a restart or a second process.
  const recorded = await dependencies.store.recordEvent({
    providerCode: dependencies.receiver.providerCode,
    providerEventId: event.eventId,
    eventType: event.eventType,
    providerReference: event.providerReference,
    paymentId: payment?.paymentId,
    organizationId: payment?.organizationId,
    disposition,
  });

  if (recorded === 'duplicate') {
    return { kind: 'duplicate' };
  }
  if (payment === undefined) {
    return { kind: 'unmatched' };
  }
  if (disposition === 'ignored') {
    return { kind: 'ignored' };
  }

  await dependencies.store.bringInquiryForward(payment.paymentId, payment.organizationId);
  return { kind: 'scheduled_read', paymentId: payment.paymentId };
}

function dispositionFor(
  requiresRead: boolean,
  isMatched: boolean,
): 'scheduled_read' | 'unmatched' | 'ignored' {
  if (!isMatched) {
    return 'unmatched';
  }
  return requiresRead ? 'scheduled_read' : 'ignored';
}
