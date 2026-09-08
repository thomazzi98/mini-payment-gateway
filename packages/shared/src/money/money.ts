import type { CurrencyCode } from './currency.js';
import { minorUnitExponentOf } from './currency.js';
import {
  CurrencyMismatchError,
  InvalidAllocationError,
  InvalidMinorUnitAmountError,
} from './money-errors.js';

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export function createMoney(amountMinor: bigint, currency: CurrencyCode): Money {
  return Object.freeze({ amountMinor, currency });
}

export function zeroMoney(currency: CurrencyCode): Money {
  return createMoney(0n, currency);
}

function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new CurrencyMismatchError(left.currency, right.currency);
  }
}

export function addMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return createMoney(left.amountMinor + right.amountMinor, left.currency);
}

export function subtractMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return createMoney(left.amountMinor - right.amountMinor, left.currency);
}

export function multiplyMoney(amount: Money, multiplier: bigint): Money {
  return createMoney(amount.amountMinor * multiplier, amount.currency);
}

export function negateMoney(amount: Money): Money {
  return createMoney(-amount.amountMinor, amount.currency);
}

export function sumMoney(amounts: readonly Money[], currency: CurrencyCode): Money {
  return amounts.reduce<Money>((running, next) => addMoney(running, next), zeroMoney(currency));
}

export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right);
  if (left.amountMinor < right.amountMinor) {
    return -1;
  }
  if (left.amountMinor > right.amountMinor) {
    return 1;
  }
  return 0;
}

export function isSameMoney(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.amountMinor === right.amountMinor;
}

export function isZeroMoney(amount: Money): boolean {
  return amount.amountMinor === 0n;
}

export function isPositiveMoney(amount: Money): boolean {
  return amount.amountMinor > 0n;
}

export function isNegativeMoney(amount: Money): boolean {
  return amount.amountMinor < 0n;
}

/**
 * Splits an amount across weights so the parts always sum back to the original.
 * Uses largest-remainder: the leftover minor units go to the largest remainders
 * first, ties broken by position, so the same input always yields the same split.
 */
export function allocateMoney(total: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) {
    throw new InvalidAllocationError('Allocation requires at least one weight.');
  }
  if (weights.some((weight) => weight < 0n)) {
    throw new InvalidAllocationError('Allocation weights must not be negative.');
  }
  if (total.amountMinor < 0n) {
    throw new InvalidAllocationError('Allocation requires a non-negative total.');
  }

  const weightTotal = weights.reduce((running, weight) => running + weight, 0n);
  if (weightTotal === 0n) {
    throw new InvalidAllocationError('Allocation weights must not sum to zero.');
  }

  const distributions = weights.map((weight, position) => {
    const scaled = total.amountMinor * weight;
    return {
      position,
      base: scaled / weightTotal,
      remainder: scaled % weightTotal,
    };
  });

  const allocated = distributions.reduce((running, entry) => running + entry.base, 0n);
  let unallocatedUnits = total.amountMinor - allocated;

  const byRemainderThenPosition = distributions.toSorted((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1;
    }
    return left.position - right.position;
  });

  const extraUnits = new Map<number, bigint>();
  for (const entry of byRemainderThenPosition) {
    if (unallocatedUnits <= 0n) {
      break;
    }
    extraUnits.set(entry.position, 1n);
    unallocatedUnits -= 1n;
  }

  return distributions.map((entry) =>
    createMoney(entry.base + (extraUnits.get(entry.position) ?? 0n), total.currency),
  );
}

/**
 * Validates a value arriving from an external request. Anything that is not an
 * exact integer is refused rather than coerced: a request carrying 19.99 is a
 * caller who believes this API takes major units, and silently rounding it
 * charges the wrong amount.
 */
export function parseMinorUnitAmount(candidate: unknown): bigint {
  if (typeof candidate === 'bigint') {
    return candidate;
  }
  if (typeof candidate !== 'number') {
    throw new InvalidMinorUnitAmountError('Amount must be an integer number of minor units.');
  }
  if (Number.isSafeInteger(candidate)) {
    return BigInt(candidate);
  }
  // The safe-integer case already returned above. This check exists only to tell
  // "an integer, but too large" apart from "not an integer at all", so the caller is told
  // which mistake they actually made.
  // eslint-disable-next-line unicorn/prefer-number-is-safe-integer
  if (Number.isFinite(candidate) && candidate % 1 === 0) {
    throw new InvalidMinorUnitAmountError('Amount exceeds the safe integer range.');
  }
  throw new InvalidMinorUnitAmountError(
    'Amount must be an integer number of minor units, such as 10050 for BRL 100.50.',
  );
}

export function formatMoney(amount: Money, locale = 'en-US'): string {
  const exponent = minorUnitExponentOf(amount.currency);
  const isNegative = amount.amountMinor < 0n;
  const sign = isNegative ? '-' : '';
  const absolute = isNegative ? -amount.amountMinor : amount.amountMinor;
  const divisor = 10n ** BigInt(exponent);
  const wholeText = new Intl.NumberFormat(locale).format(absolute / divisor);

  if (exponent === 0) {
    return `${sign}${amount.currency} ${wholeText}`;
  }

  const fractionText = (absolute % divisor).toString().padStart(exponent, '0');
  const decimalSeparator = new Intl.NumberFormat(locale).format(1.1).charAt(1);
  return `${sign}${amount.currency} ${wholeText}${decimalSeparator}${fractionText}`;
}
