export interface CurrencyDefinition {
  readonly code: string;
  readonly minorUnitExponent: number;
}

export const SUPPORTED_CURRENCIES = {
  BRL: { code: 'BRL', minorUnitExponent: 2 },
} as const satisfies Record<string, CurrencyDefinition>;

export type CurrencyCode = keyof typeof SUPPORTED_CURRENCIES;

export function isSupportedCurrency(candidate: unknown): candidate is CurrencyCode {
  return typeof candidate === 'string' && Object.hasOwn(SUPPORTED_CURRENCIES, candidate);
}

export function minorUnitExponentOf(currency: CurrencyCode): number {
  return SUPPORTED_CURRENCIES[currency].minorUnitExponent;
}
