import { describe, expect, it } from 'vitest';
import type { Money } from './money.js';
import {
  addMoney,
  allocateMoney,
  compareMoney,
  createMoney,
  formatMoney,
  isNegativeMoney,
  isPositiveMoney,
  isZeroMoney,
  isSameMoney,
  multiplyMoney,
  negateMoney,
  parseMinorUnitAmount,
  subtractMoney,
  sumMoney,
  zeroMoney,
} from './money.js';
import {
  CurrencyMismatchError,
  InvalidAllocationError,
  InvalidMinorUnitAmountError,
} from './money-errors.js';

const brl = (amountMinor: bigint) => createMoney(amountMinor, 'BRL');

describe('money arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(addMoney(brl(10_050n), brl(2950n)).amountMinor).toBe(13_000n);
    expect(subtractMoney(brl(10_050n), brl(50n)).amountMinor).toBe(10_000n);
  });

  it('keeps precision where floating point would not', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. In minor units it is exact.
    expect(addMoney(brl(10n), brl(20n)).amountMinor).toBe(30n);
  });

  it('multiplies and negates', () => {
    expect(multiplyMoney(brl(1999n), 3n).amountMinor).toBe(5997n);
    expect(negateMoney(brl(500n)).amountMinor).toBe(-500n);
  });

  it('sums a list', () => {
    expect(sumMoney([brl(100n), brl(250n), brl(1n)], 'BRL').amountMinor).toBe(351n);
    expect(sumMoney([], 'BRL').amountMinor).toBe(0n);
  });

  it('refuses to combine different currencies', () => {
    // Cast at the boundary only: a second supported currency does not exist yet, but the
    // guard must already hold, because the day one is added is not the day to discover this.
    const mismatched = { amountMinor: 100n, currency: 'USD' } as unknown as Money;
    expect(() => addMoney(brl(100n), mismatched)).toThrow(CurrencyMismatchError);
  });

  it('compares and tests sign', () => {
    expect(compareMoney(brl(1n), brl(2n))).toBe(-1);
    expect(compareMoney(brl(2n), brl(1n))).toBe(1);
    expect(compareMoney(brl(2n), brl(2n))).toBe(0);
    expect(isSameMoney(brl(5n), brl(5n))).toBe(true);
    expect(isZeroMoney(zeroMoney('BRL'))).toBe(true);
    expect(isPositiveMoney(brl(1n))).toBe(true);
    expect(isNegativeMoney(brl(-1n))).toBe(true);
  });
});

describe('allocation', () => {
  it('splits indivisible amounts without losing or creating a minor unit', () => {
    const parts = allocateMoney(brl(100n), [1n, 1n, 1n]);
    expect(parts.map((part) => part.amountMinor)).toEqual([34n, 33n, 33n]);
  });

  it('respects weighting', () => {
    const parts = allocateMoney(brl(1000n), [7n, 3n]);
    expect(parts.map((part) => part.amountMinor)).toEqual([700n, 300n]);
  });

  it('is deterministic for identical input', () => {
    const first = allocateMoney(brl(101n), [1n, 1n, 1n]);
    const second = allocateMoney(brl(101n), [1n, 1n, 1n]);
    expect(first).toEqual(second);
  });

  it('handles zero weights without dropping units', () => {
    const parts = allocateMoney(brl(10n), [0n, 1n]);
    expect(parts.map((part) => part.amountMinor)).toEqual([0n, 10n]);
  });

  it('always sums back to the total across many random splits', () => {
    let seed = 987_654_321;
    const nextRandom = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };

    for (let iteration = 0; iteration < 2000; iteration += 1) {
      const total = BigInt(nextRandom() % 1_000_000);
      const weightCount = (nextRandom() % 8) + 1;
      const weights = Array.from({ length: weightCount }, () => BigInt(nextRandom() % 100));
      if (weights.every((weight) => weight === 0n)) {
        continue;
      }

      const parts = allocateMoney(brl(total), weights);
      const recombined = parts.reduce((running, part) => running + part.amountMinor, 0n);
      expect(recombined).toBe(total);
      expect(parts.every((part) => part.amountMinor >= 0n)).toBe(true);
    }
  });

  it('rejects malformed allocations', () => {
    expect(() => allocateMoney(brl(10n), [])).toThrow(InvalidAllocationError);
    expect(() => allocateMoney(brl(10n), [-1n])).toThrow(InvalidAllocationError);
    expect(() => allocateMoney(brl(-1n), [1n])).toThrow(InvalidAllocationError);
    expect(() => allocateMoney(brl(10n), [0n, 0n])).toThrow(InvalidAllocationError);
  });
});

describe('parsing amounts from external requests', () => {
  it('accepts integer minor units', () => {
    expect(parseMinorUnitAmount(10_050)).toBe(10_050n);
    expect(parseMinorUnitAmount(0)).toBe(0n);
    expect(parseMinorUnitAmount(123n)).toBe(123n);
  });

  it('refuses a major-unit decimal rather than rounding it', () => {
    expect(() => parseMinorUnitAmount(19.99)).toThrow(InvalidMinorUnitAmountError);
    expect(() => parseMinorUnitAmount(0.1)).toThrow(InvalidMinorUnitAmountError);
  });

  it('refuses unsafe and non-numeric values', () => {
    expect(() => parseMinorUnitAmount(Number.MAX_SAFE_INTEGER + 2)).toThrow(
      InvalidMinorUnitAmountError,
    );
    expect(() => parseMinorUnitAmount('10050')).toThrow(InvalidMinorUnitAmountError);
    expect(() => parseMinorUnitAmount(null)).toThrow(InvalidMinorUnitAmountError);
    expect(() => parseMinorUnitAmount(NaN)).toThrow(InvalidMinorUnitAmountError);
  });
});

describe('formatting', () => {
  it('renders minor units as a human amount', () => {
    expect(formatMoney(brl(10_050n))).toBe('BRL 100.50');
    expect(formatMoney(brl(5n))).toBe('BRL 0.05');
    expect(formatMoney(brl(-2500n))).toBe('-BRL 25.00');
    expect(formatMoney(brl(0n))).toBe('BRL 0.00');
  });
});
