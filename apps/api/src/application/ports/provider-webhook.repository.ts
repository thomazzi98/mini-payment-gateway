/**
 * What webhook ingestion needs from storage.
 *
 * Two writes and no reasoning. Deduplication is the database's, because it is the
 * only place that survives a restart and that two processes agree on.
 */

export interface MatchedPayment {
  readonly paymentId: string;
  readonly organizationId: string;
}

export interface WebhookIngestionStore {
  /**
   * Finds the payment a provider reference belongs to.
   *
   * Ownership comes from the reference: it was recorded on an attempt against one
   * payment of one merchant, so a notification cannot be aimed at anybody else's.
   */
  findPaymentByProviderReference(
    providerCode: string,
    providerReference: string,
  ): Promise<MatchedPayment | undefined>;

  /**
   * Records the delivery. `duplicate` when this provider has sent it before.
   */
  recordEvent(event: {
    readonly providerCode: string;
    readonly providerEventId: string;
    readonly eventType: string;
    readonly providerReference: string | undefined;
    readonly paymentId: string | undefined;
    readonly organizationId: string | undefined;
    readonly disposition: 'scheduled_read' | 'unmatched' | 'ignored';
  }): Promise<'recorded' | 'duplicate'>;

  /**
   * Makes the payment due for inquiry now.
   *
   * The whole effect a notification is permitted to have. It changes when a
   * question is asked, never what the answer is.
   */
  bringInquiryForward(paymentId: string, organizationId: string): Promise<void>;
}
