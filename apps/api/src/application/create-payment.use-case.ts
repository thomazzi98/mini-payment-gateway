import {
  canFailOver,
  canRetrySameProvider,
  isTerminalForPayment,
  requiresReconciliation,
} from '../domain/provider/provider-outcome.js';
import type { ProviderOutcomeClass } from '../domain/provider/provider-outcome.js';
import { assertPresentableBrCode } from '../domain/pix/br-code.js';
import type { PaymentMethod, ProviderDescriptor } from '../domain/provider/provider-capability.js';
import type { ProviderRegistry } from './provider-registry.js';
import type {
  CreatePixInstrumentRequest,
  CryptoInstrument,
  CryptoPaymentProvider,
  PixInstrument,
  PixPaymentProvider,
  ProviderResult,
} from './ports/payment-provider.js';

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
    readonly paymentMethod: PaymentMethod;
    readonly currency: string;
    readonly expectedAmountMinor: bigint;
    /**
     * Where the customer is told the payment went through. Kept on the payment
     * because the paid event is built from the payment row alone.
     */
    readonly customerPhone: string | undefined;
    readonly idempotencyKey: string;
    readonly requestPath: string;
    readonly requestBody: unknown;
  }): Promise<
    | { readonly kind: 'created'; readonly paymentId: string; readonly publicId: string }
    | { readonly kind: 'replayed'; readonly responseStatus: number; readonly responseBody: unknown }
    | { readonly kind: 'in_flight' }
    | { readonly kind: 'conflict' }
    | { readonly kind: 'duplicate_merchant_reference' }
    | { readonly kind: 'stranded' }
    | { readonly kind: 'amount_exceeds_limit'; readonly maximumAmountMinor: bigint }
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
    /**
     * False while the payment is still being routed. The claim stays open until
     * an outcome is actually returned to the caller, so a replay never sees a
     * response that was superseded by the next attempt.
     */
    readonly completesRequest: boolean;
    readonly responseStatus: number;
    readonly responseBody: unknown;
    readonly instrumentExpiresAt: Date | undefined;
    /**
     * The instrument as it is being presented, kept so a later read of the
     * payment can show the same destination the customer was given.
     */
    readonly instrument: PresentedInstrument | undefined;
  }): Promise<void>;
}

export type CreatePaymentInput = {
  readonly organizationId: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly merchantReference: string;
  readonly currency: string;
  readonly expectedAmountMinor: bigint;
  readonly description: string;
  readonly idempotencyKey: string;
  readonly requestPath: string;
  readonly requestBody: unknown;
} & (
  | {
      readonly paymentMethod: 'pix';
      readonly customer: CreatePixInstrumentRequest['customer'];
    }
  | {
      readonly paymentMethod: 'crypto';
      /**
       * Which network the merchant wants the destination on, or any the
       * registered providers offer.
       */
      readonly network: string | undefined;
      /**
       * Optional: the crypto rails need nothing about the payer. What is given is
       * kept only so the customer can be told when the money arrives.
       */
      readonly customerPhone: string | undefined;
    }
);

export type PresentedInstrument =
  | {
      readonly type: 'pix';
      readonly copyAndPasteCode: string;
      readonly qrCodeImageDataUri?: string;
      readonly expiresAt?: string;
    }
  | {
      readonly type: 'crypto';
      readonly network: string;
      readonly asset: string;
      readonly destinationAddress: string;
      readonly paymentUri: string;
      readonly qrCodeImageDataUri: string;
      readonly expiresAt?: string;
    };

export interface PaymentView {
  readonly id: string;
  readonly status: string;
  readonly paymentMethod: PaymentMethod;
  readonly amountMinor: string;
  readonly currency: string;
  readonly merchantReference: string;
  /**
   * Present when the payment did not succeed. A stable machine-readable code
   * plus prose, so a merchant can branch on the code and show the sentence.
   */
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly instrument?: PresentedInstrument;
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
   * Every provider that could have served it refused, each confirming it created
   * nothing. The payment is declined rather than unroutable.
   */
  routing_exhausted: 402,
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
  | { readonly kind: 'stranded' }
  | { readonly kind: 'amount_exceeds_limit'; readonly maximumAmountMinor: bigint }
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
    // The provider answered and said it created nothing, so the read is real.
    return {
      toStatus: 'pending',
      trigger: 'SAFE_FAILURE_OBSERVED',
      evidenceClass: 'authenticated_provider_read',
    };
  }
  if (canRetrySameProvider(outcome)) {
    // Nothing was created, but nobody was read either: the call did not arrive.
    // Recording this as an authenticated read would audit a conversation that
    // never happened, and recording it as PROVIDER_REFUSED would blame a
    // provider that never saw the request.
    return {
      toStatus: 'pending',
      trigger: 'SAFE_FAILURE_OBSERVED',
      evidenceClass: 'internal',
    };
  }
  if (isTerminalForPayment(outcome)) {
    return {
      toStatus: 'failed',
      trigger: 'PROVIDER_REFUSED',
      evidenceClass: 'authenticated_provider_read',
    };
  }

  // Everything else, including any class added later, is treated as unknown.
  // The conservative reading costs a reconciliation; the optimistic one costs a
  // duplicate charge.
  return {
    toStatus: 'unknown',
    trigger: 'PROVIDER_OUTCOME_UNKNOWN',
    evidenceClass: 'internal',
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
    paymentMethod: input.paymentMethod,
    currency: input.currency,
    expectedAmountMinor: input.expectedAmountMinor,
    customerPhone: customerPhoneOf(input),
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
  if (claimed.kind === 'stranded') {
    return { kind: 'stranded' };
  }
  if (claimed.kind === 'amount_exceeds_limit') {
    return { kind: 'amount_exceeds_limit', maximumAmountMinor: claimed.maximumAmountMinor };
  }

  // The environment comes from the payment, which took it from the API key. A
  // production payment is never served by a sandbox registration.
  const candidates = candidatesFor(input, dependencies.providers, claimed.publicId);
  if (candidates.length === 0) {
    return await abandonPayment(input, dependencies, claimed.publicId, claimed.paymentId, {
      reason: describeUnservable(input),
      failureCode: 'no_provider_available',
      responseStatus: RESPONSE_STATUS.no_provider,
      kind: 'no_provider',
    });
  }

  /**
   * Failover is bounded by the candidate list and only ever moves forward on a
   * class that proves nothing was created.
   *
   * A success, a definitive refusal and an unknown outcome all stop the loop. The
   * unknown case is the one that matters: the request may have created something
   * payable, so trying the next provider is exactly how a customer ends up
   * holding two payable codes for one order.
   */
  let lastRefusal = 'Every provider refused the payment.';

  for (const [index, candidate] of candidates.entries()) {
    const attemptId = await dependencies.store.openAttempt({
      organizationId: input.organizationId,
      paymentId: claimed.paymentId,
      attemptNumber: index + 1,
      providerCode: candidate.descriptor.code,
    });

    const result = await attemptInstrument(candidate);

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
    const responseStatus = RESPONSE_STATUS[kind];

    const presented =
      instrument !== undefined && unusableInstrument === undefined
        ? presentInstrument(instrument)
        : undefined;

    const payment: PaymentView = {
      id: claimed.publicId,
      status: transition.toStatus,
      paymentMethod: input.paymentMethod,
      amountMinor: input.expectedAmountMinor.toString(),
      currency: input.currency,
      merchantReference: input.merchantReference,
      ...(kind !== 'created' && {
        failureCode: kind === 'uncertain' ? 'provider_outcome_unknown' : 'provider_rejected',
      }),
      ...(failureReason !== undefined && { failureReason }),
      ...(presented !== undefined && { instrument: presented }),
    };

    const canTryAnotherProvider =
      canFailOver(effectiveOutcome) || canRetrySameProvider(effectiveOutcome);

    await dependencies.store.applyProviderOutcome({
      organizationId: input.organizationId,
      paymentId: claimed.paymentId,
      attemptId,
      outcomeClass: effectiveOutcome,
      providerReference: result.providerReference,
      failureReason,
      toStatus: transition.toStatus,
      trigger: transition.trigger,
      evidenceClass: transition.evidenceClass,
      idempotencyKey: input.idempotencyKey,
      environment: input.environment,
      // A payment that will be tried against another provider has not answered
      // the caller yet, so its claim stays open until the loop settles.
      completesRequest: !canTryAnotherProvider,
      responseStatus,
      responseBody: payment,
      // Only when the instrument is one we are actually presenting. An expiry
      // recorded for a code nobody will see would later expire a payment that
      // never had a live instrument at all.
      instrumentExpiresAt: presented === undefined ? undefined : expiryOf(instrument),
      instrument: presented,
    });

    if (kind === 'created') {
      return { kind, payment, responseStatus };
    }
    if (kind === 'uncertain') {
      return {
        kind,
        payment,
        responseStatus,
        reason: failureReason ?? 'The provider outcome could not be determined.',
      };
    }
    if (!canTryAnotherProvider) {
      return {
        kind,
        payment,
        responseStatus,
        reason: rejection ?? 'The provider refused the payment.',
      };
    }

    lastRefusal = failureReason ?? lastRefusal;
  }

  // Every candidate refused, each confirming it created nothing. The payment is
  // back in pending, holding its merchant reference, so it must be closed.
  return await abandonPayment(input, dependencies, claimed.publicId, claimed.paymentId, {
    reason: lastRefusal,
    failureCode: 'all_providers_refused',
    responseStatus: RESPONSE_STATUS.routing_exhausted,
    kind: 'no_provider',
  });
}

/**
 * What a provider issued, tagged by kind so the checks that follow cannot apply
 * a Pix rule to a crypto destination or the other way round.
 */
type IssuedInstrument =
  | { readonly kind: 'pix'; readonly pix: PixInstrument }
  | { readonly kind: 'crypto'; readonly crypto: CryptoInstrument };

/**
 * One provider that could serve this payment, closed over the request it would
 * be asked to serve. Failover iterates these without knowing which rails they
 * are, which is the whole reason the loop above stays one loop.
 */
interface RoutingCandidate {
  readonly descriptor: ProviderDescriptor;
  issue(): Promise<ProviderResult<IssuedInstrument>>;
}

function candidatesFor(
  input: CreatePaymentInput,
  registry: ProviderRegistry,
  paymentId: string,
): RoutingCandidate[] {
  if (input.paymentMethod === 'pix') {
    return registry
      .candidatesForPix('pix', input.currency, input.environment)
      .map((provider) => pixCandidate(provider, input));
  }
  return registry
    .candidatesForCrypto(input.currency, input.environment, input.network)
    .map((provider) => cryptoCandidate(provider, input, paymentId));
}

function describeUnservable(input: CreatePaymentInput): string {
  const where =
    input.paymentMethod === 'crypto' && input.network !== undefined ? ` on ${input.network}` : '';
  return `No configured provider can serve ${input.paymentMethod} in ${input.currency}${where} for ${input.environment}.`;
}

function pixCandidate(
  provider: PixPaymentProvider,
  input: CreatePaymentInput & { readonly paymentMethod: 'pix' },
): RoutingCandidate {
  return {
    descriptor: provider.descriptor,
    issue: async () => {
      const result = await provider.createPixInstrument({
        amountMinor: input.expectedAmountMinor,
        currency: input.currency,
        description: input.description,
        reference: input.merchantReference,
        customer: input.customer,
      });
      return result.outcome === 'success'
        ? { ...result, value: { kind: 'pix', pix: result.value } }
        : result;
    },
  };
}

function cryptoCandidate(
  provider: CryptoPaymentProvider,
  input: CreatePaymentInput & { readonly paymentMethod: 'crypto' },
  paymentId: string,
): RoutingCandidate {
  return {
    descriptor: provider.descriptor,
    issue: async () => {
      const result = await provider.createCryptoInstrument({
        amountMinor: input.expectedAmountMinor,
        currency: input.currency,
        description: input.description,
        paymentId,
        merchantReference: input.merchantReference,
        network: input.network,
        // Our own claim key, so a retry of the same merchant request reaches the
        // provider as the same request and is answered with the same destination.
        idempotencyKey: input.idempotencyKey,
      });
      return result.outcome === 'success'
        ? { ...result, value: { kind: 'crypto', crypto: result.value } }
        : result;
    },
  };
}

function customerPhoneOf(input: CreatePaymentInput): string | undefined {
  if (input.paymentMethod === 'pix') {
    return input.customer.phone;
  }
  return input.customerPhone;
}

/**
 * Calls the provider, turning an exception into an outcome rather than letting it
 * escape.
 *
 * An adapter that throws would otherwise unwind past the point where the attempt
 * is closed, leaving the payment in `processing` and its idempotency claim open
 * forever. There is no way to tell from an exception whether the request arrived,
 * so the only honest reading is that we do not know.
 */
async function attemptInstrument(
  candidate: RoutingCandidate,
): Promise<ProviderResult<IssuedInstrument>> {
  try {
    return await candidate.issue();
  } catch (error) {
    return {
      outcome: 'unknown_outcome',
      reason:
        error instanceof Error
          ? `The provider call ended in an error: ${error.message}`
          : 'The provider call ended in an error.',
    };
  }
}

/**
 * Closes a payment that no provider will carry, and releases its claim.
 *
 * Left open, the idempotency key answers "still being processed" to every retry
 * forever and the payment goes on holding the merchant reference.
 */
async function abandonPayment(
  input: CreatePaymentInput,
  dependencies: CreatePaymentDependencies,
  publicId: string,
  paymentId: string,
  failure: {
    readonly reason: string;
    readonly failureCode: string;
    readonly responseStatus: number;
    readonly kind: 'no_provider';
  },
): Promise<CreatePaymentOutcome> {
  const payment: PaymentView = {
    id: publicId,
    status: 'failed',
    paymentMethod: input.paymentMethod,
    amountMinor: input.expectedAmountMinor.toString(),
    currency: input.currency,
    merchantReference: input.merchantReference,
    failureCode: failure.failureCode,
    failureReason: failure.reason,
  };

  await dependencies.store.failRouting({
    organizationId: input.organizationId,
    paymentId,
    reason: failure.reason,
    idempotencyKey: input.idempotencyKey,
    environment: input.environment,
    responseStatus: failure.responseStatus,
    responseBody: payment,
  });

  return {
    kind: failure.kind,
    reason: failure.reason,
    payment,
    responseStatus: failure.responseStatus,
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
  instrument: IssuedInstrument,
  expectedAmountMinor: bigint,
): string | undefined {
  if (instrument.kind === 'crypto') {
    // The destination asks the customer for a fixed amount. One that differs from
    // what the merchant requested must never be shown, however it came about.
    return instrument.crypto.amountMinor === expectedAmountMinor
      ? undefined
      : `The provider issued a destination for ${instrument.crypto.amountMinor} minor units, not the ${expectedAmountMinor} requested.`;
  }
  try {
    assertPresentableBrCode(instrument.pix.copyAndPasteCode, expectedAmountMinor);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'The Pix code could not be validated.';
  }
}

function expiryOf(instrument: IssuedInstrument | undefined): Date | undefined {
  if (instrument === undefined) {
    return undefined;
  }
  return instrument.kind === 'pix' ? instrument.pix.expiresAt : instrument.crypto.expiresAt;
}

function presentInstrument(instrument: IssuedInstrument): PresentedInstrument {
  if (instrument.kind === 'crypto') {
    const { crypto } = instrument;
    return {
      type: 'crypto',
      network: crypto.network,
      asset: crypto.asset,
      destinationAddress: crypto.destinationAddress,
      paymentUri: crypto.paymentUri,
      qrCodeImageDataUri: crypto.qrCodeImageDataUri,
      ...(crypto.expiresAt !== undefined && { expiresAt: crypto.expiresAt.toISOString() }),
    };
  }
  const { pix } = instrument;
  return {
    type: 'pix',
    copyAndPasteCode: pix.copyAndPasteCode,
    ...(pix.qrCodeImageDataUri !== undefined && { qrCodeImageDataUri: pix.qrCodeImageDataUri }),
    ...(pix.expiresAt !== undefined && { expiresAt: pix.expiresAt.toISOString() }),
  };
}
