/**
 * How a provider call ended, classified by what it licenses us to do next.
 *
 * This is the taxonomy the whole failover story rests on. The question is never
 * "did the call succeed" but "do we know whether anything was created", because
 * retrying or failing over on a call that may have created a payable instrument
 * is how a customer gets charged twice.
 */

export const PROVIDER_OUTCOME_CLASSES = [
  /**
   * The provider did what was asked and said so.
   */
  'success',

  /**
   * The provider refused and confirmed it created nothing. The only class from
   * which another provider may be attempted immediately.
   */
  'safe_failure',

  /**
   * The provider refused in a way that is final for this payment. Retrying the
   * same provider is pointless; the payment fails.
   */
  'definitive_failure',

  /**
   * The call itself failed in a way that created nothing — a connection refused
   * before any bytes were sent, a request rejected by our own validation. Safe to
   * retry the same provider.
   */
  'retryable_transport_failure',

  /**
   * The call may or may not have taken effect: a timeout after the request was
   * sent, a 5xx, an unparseable body, a connection reset mid-response.
   *
   * NOT a failure. Treating it as one is the mistake that double-charges. No
   * retry and no failover is permitted until a read proves what happened.
   */
  'unknown_outcome',
] as const;

export type ProviderOutcomeClass = (typeof PROVIDER_OUTCOME_CLASSES)[number];

/**
 * Whether another provider may be attempted without risking a second charge.
 */
export function canFailOver(outcome: ProviderOutcomeClass): boolean {
  return outcome === 'safe_failure';
}

/**
 * Whether the same provider may be called again with the same intent.
 */
export function canRetrySameProvider(outcome: ProviderOutcomeClass): boolean {
  return outcome === 'retryable_transport_failure';
}

/**
 * Whether the outcome must be resolved by reading provider state before anything else.
 */
export function requiresReconciliation(outcome: ProviderOutcomeClass): boolean {
  return outcome === 'unknown_outcome';
}

export function isTerminalForPayment(outcome: ProviderOutcomeClass): boolean {
  return outcome === 'definitive_failure';
}

/**
 * Maps a transport-level result onto the taxonomy.
 *
 * The default is deliberately `unknown_outcome`. An HTTP status nobody has
 * classified, or an error nobody anticipated, must not be assumed harmless: the
 * conservative reading costs a reconciliation, and the optimistic one costs a
 * duplicate charge.
 */
export interface TransportResult {
  readonly kind: 'response' | 'timeout' | 'connection_error' | 'malformed_body';
  readonly httpStatus?: number;
  /**
   * True only when the call provably never reached the provider, such as a
   * connection refused before any bytes were written.
   */
  readonly requestDefinitelyNotDelivered?: boolean;
}

export function classifyTransportResult(result: TransportResult): ProviderOutcomeClass {
  if (result.kind === 'connection_error') {
    return result.requestDefinitelyNotDelivered === true
      ? 'retryable_transport_failure'
      : 'unknown_outcome';
  }

  if (result.kind === 'timeout' || result.kind === 'malformed_body') {
    return 'unknown_outcome';
  }

  const status = result.httpStatus ?? 0;

  if (status >= 200 && status < 300) {
    return 'success';
  }

  // 4xx means the provider understood the request and declined it, so nothing was
  // created. 408 and 429 are the exceptions: the first is a timeout wearing a
  // status code, and the second says nothing about what a prior attempt did.
  if (status === 408) {
    return 'unknown_outcome';
  }
  if (status === 429) {
    return 'retryable_transport_failure';
  }
  if (status === 422 || status === 400) {
    return 'safe_failure';
  }
  if (status === 401 || status === 403) {
    return 'definitive_failure';
  }
  if (status === 404) {
    return 'definitive_failure';
  }
  if (status >= 400 && status < 500) {
    return 'safe_failure';
  }

  // A 5xx says the provider broke, not that it did nothing. It may well have
  // committed the order and failed on the way back.
  return 'unknown_outcome';
}
