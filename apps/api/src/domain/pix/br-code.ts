/**
 * Validation of the Pix "copy and paste" string, the EMV BR Code.
 *
 * This is domain, not provider code: a BR Code is defined by the central bank, not
 * by whoever handed it to us. Every provider that returns one returns the same
 * format, and every one of them must be checked before it reaches a customer.
 *
 * A malformed code is worse than a missing one. A missing code is an error the
 * customer sees immediately; a malformed one is a customer staring at a banking
 * app that refuses to scan, with a payment the gateway believes is live.
 */

const CRC_FIELD_IDENTIFIER = '6304';
const CRC_LENGTH = 4;
const CRC_POLYNOMIAL = 0x10_21;
const CRC_INITIAL_VALUE = 0xff_ff;
const SIXTEEN_BIT_MASK = 0xff_ff;
const HIGH_BIT = 0x80_00;

/**
 * Tag 54 in the BR Code carries the transaction amount, in major units.
 */
const AMOUNT_TAG = '54';
const PIX_DOMAIN_MARKER = 'br.gov.bcb.pix';

export class InvalidBrCodeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidBrCodeError';
  }
}

/**
 * CRC16/CCITT-FALSE, which is what the BR Code specification requires.
 *
 * Computed over the whole payload including the "6304" field identifier and
 * excluding the four checksum characters themselves.
 */
export function computeBrCodeChecksum(payloadWithoutChecksum: string): string {
  let crc = CRC_INITIAL_VALUE;

  for (const character of payloadWithoutChecksum) {
    crc ^= (character.codePointAt(0) ?? 0) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      const isHighBitSet = (crc & HIGH_BIT) !== 0;
      crc = (crc << 1) & SIXTEEN_BIT_MASK;
      if (isHighBitSet) {
        crc ^= CRC_POLYNOMIAL;
      }
    }
  }

  return crc.toString(16).toUpperCase().padStart(CRC_LENGTH, '0');
}

export function hasValidBrCodeChecksum(payload: string): boolean {
  const checksumStart = payload.lastIndexOf(CRC_FIELD_IDENTIFIER);
  if (
    checksumStart === -1 ||
    checksumStart + CRC_FIELD_IDENTIFIER.length + CRC_LENGTH !== payload.length
  ) {
    return false;
  }

  const withoutChecksum = payload.slice(0, checksumStart + CRC_FIELD_IDENTIFIER.length);
  const declared = payload.slice(checksumStart + CRC_FIELD_IDENTIFIER.length).toUpperCase();

  return computeBrCodeChecksum(withoutChecksum) === declared;
}

/**
 * Reads the amount the code actually instructs the customer to pay.
 *
 * Returned in minor units so it can be compared against the payment without ever
 * becoming a float. The BR Code carries major units as text ("10.00"), so the
 * fractional part is parsed as digits rather than through parseFloat.
 */
export function readBrCodeAmountMinor(payload: string): bigint | undefined {
  let cursor = 0;

  while (cursor + 4 <= payload.length) {
    const tag = payload.slice(cursor, cursor + 2);
    const length = Number(payload.slice(cursor + 2, cursor + 4));
    if (!Number.isSafeInteger(length) || length < 0) {
      return undefined;
    }

    const valueStart = cursor + 4;
    const value = payload.slice(valueStart, valueStart + length);

    if (tag === AMOUNT_TAG) {
      return parseMajorUnitsToMinor(value);
    }
    cursor = valueStart + length;
  }

  return undefined;
}

function parseMajorUnitsToMinor(value: string): bigint | undefined {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    return undefined;
  }
  const [whole = '0', fraction = ''] = value.split('.', 2);
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export interface BrCodeInspection {
  readonly hasValidChecksum: boolean;
  readonly declaresPixDomain: boolean;
  readonly amountMinor: bigint | undefined;
  /**
   * Whether the code carries an amount field at all.
   *
   * Separate from `amountMinor` because the two failures are different and both
   * matter: a code with no amount lets the payer choose what to send, and a code
   * whose amount cannot be read is one nobody has checked. Collapsing them into a
   * single undefined is what let both pass unnoticed.
   */
  readonly declaresAmount: boolean;
}

export function inspectBrCode(payload: string): BrCodeInspection {
  return {
    hasValidChecksum: hasValidBrCodeChecksum(payload),
    declaresPixDomain: payload.toLowerCase().includes(PIX_DOMAIN_MARKER),
    amountMinor: readBrCodeAmountMinor(payload),
    declaresAmount: hasBrCodeAmountTag(payload),
  };
}

/**
 * Whether the amount field is present, regardless of whether its value parses.
 */
function hasBrCodeAmountTag(payload: string): boolean {
  let cursor = 0;

  while (cursor + 4 <= payload.length) {
    const tag = payload.slice(cursor, cursor + 2);
    const length = Number(payload.slice(cursor + 2, cursor + 4));
    if (!Number.isSafeInteger(length) || length < 0) {
      return false;
    }
    if (tag === AMOUNT_TAG) {
      return true;
    }
    cursor = cursor + 4 + length;
  }

  return false;
}

/**
 * The gate a code must pass before it is shown to anybody.
 *
 * The amount is cross-checked against what the payment expects, because a code
 * that scans perfectly but asks for the wrong sum is the worst of the failure
 * modes: the customer pays, and pays the wrong amount.
 */
export function assertPresentableBrCode(payload: string, expectedAmountMinor: bigint): void {
  if (payload.length === 0) {
    throw new InvalidBrCodeError('The provider returned an empty Pix code.');
  }

  const inspection = inspectBrCode(payload);

  if (!inspection.declaresPixDomain) {
    throw new InvalidBrCodeError('The Pix code does not declare the br.gov.bcb.pix domain.');
  }
  if (!inspection.hasValidChecksum) {
    throw new InvalidBrCodeError('The Pix code failed its CRC16 checksum.');
  }

  // A code with no amount is payable for any sum the customer types, and one
  // whose amount cannot be read is one nobody has checked. Neither is presentable
  // for a payment whose amount is already agreed.
  if (!inspection.declaresAmount) {
    throw new InvalidBrCodeError('The Pix code fixes no amount, so it could be paid for any sum.');
  }
  if (inspection.amountMinor === undefined) {
    throw new InvalidBrCodeError('The Pix code carries an amount that could not be read.');
  }
  if (inspection.amountMinor !== expectedAmountMinor) {
    throw new InvalidBrCodeError(
      `The Pix code asks for ${inspection.amountMinor} minor units but the payment expects ${expectedAmountMinor}.`,
    );
  }
}
