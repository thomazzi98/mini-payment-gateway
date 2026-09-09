import { describe, expect, it } from 'vitest';
import {
  assertCapabilitiesAreImplemented,
  canServeMethod,
  capabilityForMethod,
  CapabilityNotImplementedError,
  isProviderCapability,
  PAYMENT_METHODS,
  PROVIDER_CAPABILITIES,
  hasCapability,
} from './provider-capability.js';
import type { ProviderCapability, ProviderDescriptor } from './provider-capability.js';
import {
  classifyTransportResult,
  isTerminalForPayment,
  canFailOver,
  canRetrySameProvider,
  PROVIDER_OUTCOME_CLASSES,
  requiresReconciliation,
} from './provider-outcome.js';

/**
 * Modelled on Appmax: Pix and refunds, no card, and a non-idempotent create.
 */
const pixOnlyProvider: ProviderDescriptor = {
  code: 'appmax',
  displayName: 'Appmax',
  capabilities: ['pix.create', 'pix.status', 'order.read', 'refund.full', 'webhook.receive'],
  supportedCurrencies: ['BRL'],
  instrumentCreationIsIdempotent: false,
};

describe('capabilities', () => {
  it('recognises only declared capability names', () => {
    for (const capability of PROVIDER_CAPABILITIES) {
      expect(isProviderCapability(capability)).toBe(true);
    }
    for (const impostor of ['pix.refund', 'PIX.CREATE', '', undefined, null, 7]) {
      expect(isProviderCapability(impostor)).toBe(false);
    }
  });

  it('reports what a provider does and does not do', () => {
    expect(hasCapability(pixOnlyProvider, 'pix.create')).toBe(true);
    expect(hasCapability(pixOnlyProvider, 'card.create')).toBe(false);
    expect(hasCapability(pixOnlyProvider, 'refund.partial')).toBe(false);
  });

  it('maps every payment method to the capability it requires', () => {
    for (const method of PAYMENT_METHODS) {
      expect(isProviderCapability(capabilityForMethod(method))).toBe(true);
    }
    expect(capabilityForMethod('pix')).toBe('pix.create');
  });

  it('routes only to a provider that can serve the method and the currency', () => {
    expect(canServeMethod(pixOnlyProvider, 'pix', 'BRL')).toBe(true);
    // Declares the capability but not the currency.
    expect(canServeMethod(pixOnlyProvider, 'pix', 'USD')).toBe(false);
    // Supports the currency but not the method.
    expect(canServeMethod(pixOnlyProvider, 'card', 'BRL')).toBe(false);
  });

  it('accepts a provider whose declarations are all implemented', () => {
    expect(() =>
      assertCapabilitiesAreImplemented(
        pixOnlyProvider,
        new Set<ProviderCapability>(pixOnlyProvider.capabilities),
      ),
    ).not.toThrow();
  });

  it('refuses at startup when a declared capability is missing', () => {
    // Better here than at payment time, when a customer is waiting.
    const implemented = new Set<ProviderCapability>(['pix.create', 'pix.status', 'order.read']);
    expect(() => assertCapabilitiesAreImplemented(pixOnlyProvider, implemented)).toThrow(
      CapabilityNotImplementedError,
    );
    expect(() => assertCapabilitiesAreImplemented(pixOnlyProvider, implemented)).toThrow(
      /refund\.full/,
    );
  });

  it('records that instrument creation is not safely repeatable for this provider', () => {
    // Appmax order creation carries no idempotency key and no external reference,
    // so a retry can create a second order. The routing layer needs to know.
    expect(pixOnlyProvider.instrumentCreationIsIdempotent).toBe(false);
  });
});

describe('classifying how a provider call ended', () => {
  it('treats a success as a success', () => {
    expect(classifyTransportResult({ kind: 'response', httpStatus: 200 })).toBe('success');
    expect(classifyTransportResult({ kind: 'response', httpStatus: 201 })).toBe('success');
  });

  it('treats a timeout as unknown, never as a failure', () => {
    // The request may have been received and acted on. Calling this a failure and
    // failing over is precisely how a customer gets two payable codes.
    expect(classifyTransportResult({ kind: 'timeout' })).toBe('unknown_outcome');
    expect(classifyTransportResult({ kind: 'response', httpStatus: 408 })).toBe('unknown_outcome');
  });

  it('treats a 5xx as unknown, because the provider may have committed before breaking', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyTransportResult({ kind: 'response', httpStatus: status })).toBe(
        'unknown_outcome',
      );
    }
  });

  it('treats an unreadable body as unknown', () => {
    expect(classifyTransportResult({ kind: 'malformed_body', httpStatus: 200 })).toBe(
      'unknown_outcome',
    );
  });

  it('distinguishes a connection error that provably never arrived', () => {
    expect(
      classifyTransportResult({ kind: 'connection_error', requestDefinitelyNotDelivered: true }),
    ).toBe('retryable_transport_failure');

    // A reset mid-flight says nothing about whether the provider acted.
    expect(classifyTransportResult({ kind: 'connection_error' })).toBe('unknown_outcome');
  });

  it('treats a validation rejection as a safe failure', () => {
    expect(classifyTransportResult({ kind: 'response', httpStatus: 400 })).toBe('safe_failure');
    expect(classifyTransportResult({ kind: 'response', httpStatus: 422 })).toBe('safe_failure');
  });

  it('treats an authentication or missing-resource error as final', () => {
    for (const status of [401, 403, 404]) {
      expect(classifyTransportResult({ kind: 'response', httpStatus: status })).toBe(
        'definitive_failure',
      );
    }
  });

  it('treats rate limiting as retryable against the same provider', () => {
    expect(classifyTransportResult({ kind: 'response', httpStatus: 429 })).toBe(
      'retryable_transport_failure',
    );
  });

  it('defaults an unrecognised status to unknown rather than assuming it is harmless', () => {
    expect(classifyTransportResult({ kind: 'response', httpStatus: 599 })).toBe('unknown_outcome');
    expect(classifyTransportResult({ kind: 'response' })).toBe('unknown_outcome');
  });
});

describe('what each outcome licenses', () => {
  it('permits failover only after a safe failure', () => {
    const failoverable = PROVIDER_OUTCOME_CLASSES.filter((outcome) => canFailOver(outcome));
    expect(failoverable).toEqual(['safe_failure']);
  });

  it('permits retrying the same provider only after a transport failure that arrived nowhere', () => {
    const retryable = PROVIDER_OUTCOME_CLASSES.filter((outcome) => canRetrySameProvider(outcome));
    expect(retryable).toEqual(['retryable_transport_failure']);
  });

  it('never permits failover or retry after an unknown outcome', () => {
    // The single most important assertion in this file.
    expect(canFailOver('unknown_outcome')).toBe(false);
    expect(canRetrySameProvider('unknown_outcome')).toBe(false);
    expect(requiresReconciliation('unknown_outcome')).toBe(true);
  });

  it('marks only a definitive failure as terminal for the payment', () => {
    const terminal = PROVIDER_OUTCOME_CLASSES.filter((outcome) => isTerminalForPayment(outcome));
    expect(terminal).toEqual(['definitive_failure']);
  });

  it('gives every outcome exactly one licence, so none is ambiguous', () => {
    for (const outcome of PROVIDER_OUTCOME_CLASSES) {
      const licences = [
        canFailOver(outcome),
        canRetrySameProvider(outcome),
        requiresReconciliation(outcome),
        isTerminalForPayment(outcome),
        outcome === 'success',
      ].filter(Boolean);

      expect(licences, `${outcome} should license exactly one action`).toHaveLength(1);
    }
  });
});
