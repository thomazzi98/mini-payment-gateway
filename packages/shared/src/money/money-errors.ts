export class CurrencyMismatchError extends Error {
  public constructor(
    public readonly leftCurrency: string,
    public readonly rightCurrency: string,
  ) {
    super(`Cannot combine amounts in ${leftCurrency} and ${rightCurrency}.`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidMinorUnitAmountError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidMinorUnitAmountError';
  }
}

export class InvalidAllocationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidAllocationError';
  }
}
