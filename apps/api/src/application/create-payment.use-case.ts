import { canFailOver, requiresReconciliation } from '../domain/provider/provider-outcome.js';
import type { ProviderOutcomeClass } from '../domain/provider/provider-outcome.js';
import { assertPresentableBrCode } from '../domain/pix/br-code.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { CreatePixInstrumentRequest, PixInstrument } from './ports/payment-provider.js';

/**
 * Creating a payment, end to end.
 *
 * The shape that matters: the provider is called BETWEEN two database
 * transactions, never inside one. Holding a transaction open across a network
 * round trip would keep row locks for the length of somebody else's outage.
 *
 *   claim idempotency and insert the payment   (transaction)
 *   open the attempt                           (transaction)
 *   call the provider                          (network, no locks held)
 *   close the attempt and move the payment     (transaction)
 */

export interface PaymentCreationStore {
  createPayment(command: {
    readonly organizationId: string;
    readonly environment: 'SANDBOX' | 'PRODUCTION';
    readonly merchantReference: string;
    readonly paymentMethod: 'pix' | 'card' | 'boleto';
    readonly currency: string;
    readonly expectedAmountMinor: bigint;
    readonly idempotencyKey: string;
    readonly requestPath: string;
    readonly requestBody: unknown;
  }): Promise<
    | { readonly kind: 'created'; readonly paymentId: string; readonly publicId: string }
    | { readonly kind: 'replayed'; readonly responseStatus: number; readonly responseBody: unknown }
    | { readonly kind: 'in_flight' }
    | { readonly kind: 'conflict' }
    | { readonly kind: 'duplicate_merchant_reference' }
  >;

  openAttempt(command: {
    readonly organizationId: string;
    readonly paymentId: string;
    readonly attemptNumber: number;
    readonly providerCode: string;
  }): Promise<string>;

  /**
   * Resolves a payment that never reached a provider at all.
   *
   * Without this the claim is stranded: the idempotency record stays in flight
   * forever, so every retry of that key is told the request is still running, and
   * the orphaned payment keeps holding the merchant reference.
   */
  failRouting(command: {
    readonly organizationId: string;
    readonly paymentId: string;
    readonly reason: string;
    readonly idempotencyKey: string;
    readonly environment: 'SANDBOX' | 'PRODUCTION';
    readonly responseStatus: number;
    readonly responseBody: unknown;
  }): Promise<void>;

  applyProviderOutcome(command: {
    readonly organizationId: string;
    readonly paymentId: string;
    readonly attemptId: string;
    readonly outcomeClass: string;
    readonly providerReference: string | undefined;
    readonly failureReason: string | undefined;
    readonly toStatus: string;
    readonly trigger: string;
    readonly evidenceClass: string;
    readonly idempotencyKey: string;
    readonly environment: 'SANDBOX' | 'PRODUCTION';
    readonly responseStatus: number;
    readonly responseBody: unknown;
  }): Promise<void>;
}

export interface CreatePaymentInput {
  readonly organizationId: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly merchantReference: string;
  readonly currency: string;
  readonly expectedAmountMinor: bigint;
  readonly description: string;
  readonly customer: CreatePixInstrumentRequest['customer'];
  readonly idempotencyKey: string;
  readonly requestPath: string;
  readonly requestBody: unknown;
}

export interface PaymentView {
  readonly id: string;
  readonly status: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly merchantReference: string;
  /**
   * Present when the payment did not succeed. A stable machine-readable code
   * plus prose, so a merchant can branch on the code and show the sentence.
   */
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly instrument?: {
    readonly copyAndPasteCode: string;
    readonly qrCodeImageDataUri?: string;
    readonly expiresAt?: string;
  };
}

/**
 * The status a successful reply carries, decided once.
 *
 * It travels with the outcome, is stored on the idempotency record, and is what
 * the route sends. A replay therefore returns the same status as the original by
 * construction rather than because two places were kept in step: storing 201
 * here while the route answered 202 would make a replayed uncertain payment look
 * created.
 */
const RESPONSE_STATUS = {
  /**
  Created, with a payable instrument.
  */
  created: 201,
  /**
   * Nothing could serve the payment, so it is failed and will not be retried.
   * A payment row exists, so the caller gets a payment rather than a bare error.
   */
  no_provider: 422,
  /**
   * Accepted, not yet resolved. Deliberately not an error: the request may have
   * reached the provider and may have created something payable.
   */
  uncertain: 202,
  /**
  The provider refused.
  */
  rejected: 402,
} as const;

export type CreatePaymentOutcome =
  | { readonly kind: 'created'; readonly payment: PaymentView; readonly responseStatus: number }
  | { readonly kind: 'replayed'; readonly responseStatus: number; readonly responseBody: unknown }
  | { readonly kind: 'in_flight' }
  | { readonly kind: 'idempotency_conflict' }
  | { readonly kind: 'duplicate_merchant_reference' }
  | {
      readonly kind: 'no_provider';
      readonly reason: string;
      readonly payment: PaymentView;
      readonly responseStatus: number;
    }
  | {
      readonly kind: 'rejected';
      readonly payment: PaymentView;
      readonly reason: string;
      readonly responseStatus: number;
    }
  | {
      readonly kind: 'uncertain';
      readonly payment: PaymentView;
      readonly reason: string;
      readonly responseStatus: number;
    };

/**
 * How a provider outcome moves the payment.
 *
 * `unknown_outcome` deliberately does not become a failure. The request may have
 * reached the provider and may have created something payable, and Appmax offers
 * neither an idempotency key nor an order search, so the only honest record is
 * that we do not know. Reconciliation resolves it; nothing here guesses.
 */
function transitionFor(outcome: ProviderOutcomeClass): {
  toStatus: string;
  trigger: string;
  evidenceClass: string;
} {
  if (outcome === 'success') {
    return {
      toStatus: 'awaiting_payment',
      trigger: 'INSTRUMENT_ISSUED',
      evidenceClass: 'authenticated_provider_read',
    };
  }
  if (canFailOver(outcome)) {
    return {
      toStatus: 'pending',
      trigger: 'SAFE_FAILURE_OBSERVED',
      evidenceClass: 'authenticated_provider_read',
    };
  }
  if (requiresReconciliation(outcome)) {
    return {
      toStatus: 'unknown',
      trigger: 'PROVIDER_OUTCOME_UNKNOWN',
      evidenceClass: 'internal',
    };
  }
  return {
    toStatus: 'failed',
    trigger: 'PROVIDER_REFUSED',
    evidenceClass: 'authenticated_provider_read',
  };
}

export interface CreatePaymentDependencies {
  readonly store: PaymentCreationStore;
  readonly providers: ProviderRegistry;
}

export async function createPayment(
  input: CreatePaymentInput,
  dependencies: CreatePaymentDependencies,
): Promise<CreatePaymentOutcome> {
  const claimed = await dependencies.store.createPayment({
    organizationId: input.organizationId,
    environment: input.environment,
    merchantReference: input.merchantReference,
    paymentMethod: 'pix',
    currency: input.currency,
    expectedAmountMinor: input.expectedAmountMinor,
    idempotencyKey: input.idempotencyKey,
    requestPath: input.requestPath,
    requestBody: input.requestBody,
  });

  if (claimed.kind === 'replayed') {
    return {
      kind: 'replayed',
      responseStatus: claimed.responseStatus,
      responseBody: claimed.responseBody,
    };
  }
  if (claimed.kind === 'in_flight') {
    return { kind: 'in_flight' };
  }
  if (claimed.kind === 'conflict') {
    return { kind: 'idempotency_conflict' };
  }
  if (claimed.kind === 'duplicate_merchant_reference') {
    return { kind: 'duplicate_merchant_reference' };
  }

  const selection = dependencies.providers.selectForPix('pix', input.currency);
  if (!selection.selected) {
    // The payment is failed, not abandoned. Returning here without resolving the
    // claim would leave the idempotency key permanently unusable and the merchant
    // reference held by a payment that will never go anywhere.
    const routingFailure: PaymentView = {
      id: claimed.publicId,
      status: 'failed',
      amountMinor: input.expectedAmountMinor.toString(),
      currency: input.currency,
      merchantReference: input.merchantReference,
      failureCode: 'no_provider_available',
      failureReason: selection.reason,
    };
    const routingStatus = RESPONSE_STATUS.no_provider;

    await dependencies.store.failRouting({
      organizationId: input.organizationId,
      paymentId: claimed.paymentId,
      reason: selection.reason,
      idempotencyKey: input.idempotencyKey,
      environment: input.environment,
      responseStatus: routingStatus,
      responseBody: routingFailure,
    });

    return {
      kind: 'no_provider',
      reason: selection.reason,
      payment: routingFailure,
      responseStatus: routingStatus,
    };
  }

  const attemptId = await dependencies.store.openAttempt({
    organizationId: input.organizationId,
    paymentId: claimed.paymentId,
    attemptNumber: 1,
    providerCode: selection.provider.descriptor.code,
  });

  const result = await selection.provider.createPixInstrument({
    amountMinor: input.expectedAmountMinor,
    currency: input.currency,
    description: input.description,
    reference: input.merchantReference,
    customer: input.customer,
  });

  const outcomeClass: ProviderOutcomeClass = result.outcome;
  const rejection = result.outcome === 'success' ? undefined : result.reason;
  const instrument = result.outcome === 'success' ? result.value : undefined;

  // A code that fails its checksum, or asks for the wrong amount, must never be
  // shown. Treated as uncertain rather than failed: the provider created
  // something, we simply cannot present it.
  const unusableInstrument =
    instrument === undefined
      ? undefined
      : rejectUnusableInstrument(instrument, input.expectedAmountMinor);

  const effectiveOutcome: ProviderOutcomeClass =
    unusableInstrument === undefined ? outcomeClass : 'unknown_outcome';
  const transition = transitionFor(effectiveOutcome);

  const kind = outcomeKind(effectiveOutcome);
  const failureReason = unusableInstrument ?? rejection;

  const payment: PaymentView = {
    id: claimed.publicId,
    status: transition.toStatus,
    amountMinor: input.expectedAmountMinor.toString(),
    currency: input.currency,
    merchantReference: input.merchantReference,
    ...(kind !== 'created' && {
      failureCode: kind === 'uncertain' ? 'provider_outcome_unknown' : 'provider_rejected',
    }),
    ...(failureReason !== undefined && { failureReason }),
    ...(instrument !== undefined &&
      unusableInstrument === undefined && { instrument: presentInstrument(instrument) }),
  };

  const responseStatus = RESPONSE_STATUS[kind];

  await dependencies.store.applyProviderOutcome({
    organizationId: input.organizationId,
    paymentId: claimed.paymentId,
    attemptId,
    outcomeClass: effectiveOutcome,
    providerReference: result.providerReference,
    failureReason: unusableInstrument ?? rejection,
    toStatus: transition.toStatus,
    trigger: transition.trigger,
    evidenceClass: transition.evidenceClass,
    idempotencyKey: input.idempotencyKey,
    environment: input.environment,
    // Stored so a replay answers with the status the caller actually received.
    responseStatus,
    responseBody: payment,
  });

  if (kind === 'created') {
    return { kind, payment, responseStatus };
  }
  if (kind === 'uncertain') {
    return {
      kind,
      payment,
      responseStatus,
      reason: unusableInstrument ?? rejection ?? 'The provider outcome could not be determined.',
    };
  }
  return {
    kind,
    payment,
    responseStatus,
    reason: rejection ?? 'The provider refused the payment.',
  };
}

function outcomeKind(outcome: ProviderOutcomeClass): 'created' | 'uncertain' | 'rejected' {
  if (outcome === 'success') {
    return 'created';
  }
  if (requiresReconciliation(outcome)) {
    return 'uncertain';
  }
  return 'rejected';
}

function rejectUnusableInstrument(
  instrument: PixInstrument,
  expectedAmountMinor: bigint,
): string | undefined {
  try {
    assertPresentableBrCode(instrument.copyAndPasteCode, expectedAmountMinor);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'The Pix code could not be validated.';
  }
}

function presentInstrument(instrument: PixInstrument): NonNullable<PaymentView['instrument']> {
  return {
    copyAndPasteCode: instrument.copyAndPasteCode,
    ...(instrument.qrCodeImageDataUri !== undefined && {
      qrCodeImageDataUri: instrument.qrCodeImageDataUri,
    }),
    ...(instrument.expiresAt !== undefined && { expiresAt: instrument.expiresAt.toISOString() }),
  };
}
