import { minorUnitExponentOf } from '@gateway/shared';
import type { CurrencyCode } from '@gateway/shared';

/**
 * CryptoPay speaks decimal strings: "25.000000" for USDC. The gateway speaks
 * integer minor units. Both directions are string arithmetic on purpose; a
 * floating-point step in either would be somebody's money.
 */

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

export class UnrepresentableAmountError extends Error {
  public constructor(amount: string, currency: string) {
    super(`The amount "${amount}" cannot be represented in ${currency} minor units.`);
    this.name = 'UnrepresentableAmountError';
  }
}

export function formatDecimalAmount(amountMinor: bigint, currency: CurrencyCode): string {
  const exponent = minorUnitExponentOf(currency);
  const digits = amountMinor.toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return exponent === 0 ? whole : `${whole}.${fraction}`;
}

/**
 * Refuses more precision than the currency holds rather than rounding it. A
 * provider reporting "1.0000001" USDC is reporting something this gateway cannot
 * store, and storing a rounded number would put an amount nobody said into the
 * ledger.
 */
export function parseDecimalAmount(amount: string, currency: CurrencyCode): bigint {
  const match = DECIMAL_PATTERN.exec(amount.trim());
  if (match === null) {
    throw new UnrepresentableAmountError(amount, currency);
  }
  const exponent = minorUnitExponentOf(currency);
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent))) {
    throw new UnrepresentableAmountError(amount, currency);
  }
  const scaledFraction = fraction.slice(0, exponent).padEnd(exponent, '0');
  return BigInt(`${whole}${scaledFraction}`);
}
