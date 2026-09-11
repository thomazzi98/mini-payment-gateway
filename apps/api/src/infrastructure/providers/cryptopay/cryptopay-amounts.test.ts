import { describe, expect, it } from 'vitest';
import {
  formatDecimalAmount,
  parseDecimalAmount,
  UnrepresentableAmountError,
} from './cryptopay-amounts.js';

describe('decimal amounts across the CryptoPay boundary', () => {
  it('formats minor units as the decimal string the asset carries', () => {
    expect(formatDecimalAmount(25_000_000n, 'USDC')).toBe('25.000000');
    expect(formatDecimalAmount(1n, 'USDC')).toBe('0.000001');
    expect(formatDecimalAmount(0n, 'USDC')).toBe('0.000000');
    expect(formatDecimalAmount(1999n, 'BRL')).toBe('19.99');
  });

  it('parses a decimal string back into the same minor units', () => {
    expect(parseDecimalAmount('25.000000', 'USDC')).toBe(25_000_000n);
    expect(parseDecimalAmount('25', 'USDC')).toBe(25_000_000n);
    expect(parseDecimalAmount('0.5', 'USDC')).toBe(500_000n);
    expect(parseDecimalAmount('1.500000', 'USDC')).toBe(1_500_000n);
  });

  it('round-trips every amount rather than rounding one', () => {
    for (const amount of [1n, 7n, 999_999n, 1_000_000n, 123_456_789n, 9_007_199_254_740_993n]) {
      expect(parseDecimalAmount(formatDecimalAmount(amount, 'USDC'), 'USDC')).toBe(amount);
    }
  });

  it('refuses more precision than the asset holds instead of rounding it', () => {
    expect(() => parseDecimalAmount('1.0000001', 'USDC')).toThrow(UnrepresentableAmountError);
    // Trailing zeros beyond the exponent are not precision, so they are fine.
    expect(parseDecimalAmount('1.0000000', 'USDC')).toBe(1_000_000n);
  });

  it('refuses anything that is not a plain decimal', () => {
    for (const candidate of ['1e6', '-1', '1,5', 'abc', '', '1.']) {
      expect(() => parseDecimalAmount(candidate, 'USDC')).toThrow(UnrepresentableAmountError);
    }
  });
});
