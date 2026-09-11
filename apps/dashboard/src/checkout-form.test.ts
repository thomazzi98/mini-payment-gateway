import { describe, expect, it } from 'vitest';
import { validateSelection } from './checkout-form';
import type { PaymentOptions } from './gateway-client';

const options: PaymentOptions = {
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
};

const selection = {
  method: 'crypto' as const,
  currency: 'USDC',
  network: 'polygon',
  amount: '2.25',
  phone: '',
};

describe('what the form asks the gateway for', () => {
  it('turns a valid selection into the crypto request the API takes', () => {
    expect(validateSelection(selection, options, 'demo-1').request).toEqual({
      paymentMethod: 'crypto',
      amount: 2_250_000,
      currency: 'USDC',
      network: 'polygon',
      reference: 'demo-1',
      description: 'Demo checkout',
    });
  });

  it('carries the phone only when one was given', () => {
    const withPhone = validateSelection({ ...selection, phone: ' +5511988887777 ' }, options, 'r');
    expect(withPhone.request).toMatchObject({ customer: { phone: '+5511988887777' } });
    expect(validateSelection({ ...selection, phone: '11 98888' }, options, 'r').problem).toMatch(
      /international/,
    );
  });

  it('refuses before the gateway would: amount, network, and a method nobody serves', () => {
    expect(validateSelection({ ...selection, amount: '0' }, options, 'r').problem).toMatch(
      /above zero/,
    );
    expect(validateSelection({ ...selection, network: 'solana' }, options, 'r').problem).toMatch(
      /network/,
    );
    expect(validateSelection({ ...selection, method: 'pix' }, options, 'r').problem).toMatch(
      /No provider can serve PSP/,
    );
    expect(validateSelection(selection, undefined, 'r').problem).toMatch(/No provider/);
  });
});
