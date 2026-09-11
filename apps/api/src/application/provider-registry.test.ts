import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from './provider-registry.js';
import type {
  CryptoPaymentProvider,
  PixPaymentProvider,
  ProviderResult,
} from './ports/payment-provider.js';
import type { ProviderDescriptor } from '../domain/provider/provider-capability.js';

const notUsed = (): Promise<ProviderResult<never>> =>
  Promise.resolve({ outcome: 'unknown_outcome', reason: 'not used here' });

function cryptoProvider(descriptor: ProviderDescriptor): CryptoPaymentProvider {
  return { descriptor, createCryptoInstrument: notUsed, readPaymentState: notUsed };
}

function pixProvider(descriptor: ProviderDescriptor): PixPaymentProvider {
  return { descriptor, createPixInstrument: notUsed, readPaymentState: notUsed };
}

const CRYPTOPAY: ProviderDescriptor = {
  code: 'cryptopay',
  displayName: 'CryptoPay (polygon)',
  capabilities: ['crypto.create', 'crypto.status'],
  supportedCurrencies: ['USDC'],
  supportedNetworks: ['polygon'],
  instrumentCreationIsIdempotent: true,
};

const APPMAX: ProviderDescriptor = {
  code: 'appmax',
  displayName: 'Appmax',
  capabilities: ['pix.create', 'pix.status'],
  supportedCurrencies: ['BRL'],
  instrumentCreationIsIdempotent: false,
};

const registry = new ProviderRegistry([
  {
    descriptor: CRYPTOPAY,
    environment: 'SANDBOX',
    crypto: cryptoProvider(CRYPTOPAY),
    priority: 1,
  },
  { descriptor: APPMAX, environment: 'PRODUCTION', pix: pixProvider(APPMAX), priority: 1 },
]);

describe('routing crypto by network', () => {
  it('offers the provider for a network it declared and for no network at all', () => {
    expect(registry.candidatesForCrypto('USDC', 'SANDBOX')).toHaveLength(1);
    expect(registry.candidatesForCrypto('USDC', 'SANDBOX', 'polygon')).toHaveLength(1);
  });

  it('offers nothing for a network nobody declared, whatever the currency', () => {
    expect(registry.candidatesForCrypto('USDC', 'SANDBOX', 'solana')).toEqual([]);
  });

  it('never crosses environments', () => {
    expect(registry.candidatesForCrypto('USDC', 'PRODUCTION')).toEqual([]);
    expect(registry.candidatesForPix('pix', 'BRL', 'SANDBOX')).toEqual([]);
  });
});

describe('describing what can be served', () => {
  it('lists each method with the providers registered for that environment', () => {
    expect(registry.paymentOptions('SANDBOX')).toEqual({
      environment: 'SANDBOX',
      methods: [
        {
          method: 'crypto',
          providers: [
            {
              code: 'cryptopay',
              displayName: 'CryptoPay (polygon)',
              currencies: ['USDC'],
              networks: ['polygon'],
            },
          ],
        },
        { method: 'pix', providers: [] },
      ],
    });
  });

  it('reports a method nothing serves as an empty list rather than hiding it', () => {
    const production = registry.paymentOptions('PRODUCTION');
    expect(production.methods.find((entry) => entry.method === 'crypto')?.providers).toEqual([]);
    expect(production.methods.find((entry) => entry.method === 'pix')?.providers).toEqual([
      { code: 'appmax', displayName: 'Appmax', currencies: ['BRL'], networks: [] },
    ]);
  });
});
