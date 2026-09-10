/**
 * What an inbound provider notification means, in the gateway's own vocabulary.
 *
 * A notification is never evidence. It records that a provider said something and
 * brings that payment's next inquiry forward; the inquiry decides. That is not a
 * stylistic choice: a transition into a funded status demands
 * `authenticated_provider_read`, so the database itself refuses to let a
 * notification move money. Appmax sends no signature of any kind, and this is what
 * makes that survivable.
 *
 * Nothing above this port knows a provider's payload shape, event names, or
 * transport.
 */

export interface ProviderWebhookEvent {
  /**
   * Identifies this delivery, so a repeat is a repeat.
   *
   * Providers that supply one have it used directly. For providers that do not,
   * the adapter derives a stable key from the delivery's own content, which makes
   * an at-least-once redelivery of the same notification dedupe correctly.
   */
  readonly eventId: string;
  readonly eventType: string;
  /**
   * The provider's identifier for the thing the event is about, which is how the
   * payment is found. Absent when the payload named nothing recognisable.
   */
  readonly providerReference: string | undefined;
  /**
   * Whether this event could plausibly change what we believe. An event that
   * cannot is recorded and not acted on, which saves a provider call without
   * risking a missed payment.
   */
  readonly requiresRead: boolean;
}

export type ProviderWebhookParse =
  | { readonly kind: 'parsed'; readonly event: ProviderWebhookEvent }
  /**
   * The body was not something this provider sends. Recorded and refused, never
   * guessed at: a malformed notification must not be able to produce a payment
   * event of any kind.
   */
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * The seam a provider's notification arrives through.
 *
 * `verify` takes the raw bytes, never a parsed object, because a signature covers
 * what was sent rather than what a parser reconstructed. A provider with no
 * signature scheme says so, rather than pretending to check one.
 */
export interface ProviderWebhookReceiver {
  readonly providerCode: string;
  /**
   * Whether this provider signs its notifications at all. False is a fact about
   * the provider, and the reason a notification cannot fund a payment here.
   */
  readonly signsNotifications: boolean;
  verify(rawBody: Buffer, headers: Readonly<Record<string, string | undefined>>): boolean;
  parse(rawBody: Buffer): ProviderWebhookParse;
}
