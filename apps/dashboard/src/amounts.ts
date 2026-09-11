/**
 * Amounts cross the wire as integer minor units. The screen takes a decimal
 * string and turns it into those units on strings and integers only; a float
 * in between would be somebody's money.
 */

const decimals: Readonly<Record<string, number>> = { USDC: 6, BRL: 2 };

export const decimalsOf = (currency: string): number => decimals[currency] ?? 2;

// What the API accepts on a single payment, in minor units of any currency.
export const maximumMinor = 100_000_000;

const pattern = /^(\d{1,9})(?:\.(\d+))?$/;

export function parseAmount(text: string, currency: string): number | undefined {
  const match = pattern.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const scale = decimalsOf(currency);
  const fraction = match[2] ?? '';
  if (fraction.length > scale) {
    return undefined;
  }
  const minor = Number(match[1]) * 10 ** scale + Number(fraction.padEnd(scale, '0') || '0');
  return minor === 0 || minor > maximumMinor ? undefined : minor;
}

export function formatAmount(minor: string, currency: string): string {
  const scale = decimalsOf(currency);
  if (scale === 0) {
    return `${minor} ${currency}`;
  }
  const padded = minor.padStart(scale + 1, '0');
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)} ${currency}`;
}
