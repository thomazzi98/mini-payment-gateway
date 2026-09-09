import { describe, expect, it } from 'vitest';
import {
  assertPresentableBrCode,
  computeBrCodeChecksum,
  hasValidBrCodeChecksum,
  inspectBrCode,
  InvalidBrCodeError,
  readBrCodeAmountMinor,
} from './br-code.js';

/**
 * The algorithm is verified against the published check value for
 * CRC-16/CCITT-FALSE rather than against a remembered BR Code. That check value
 * comes from the CRC catalogue and is independent of this codebase, so it cannot
 * agree with a mistake made here.
 *
 * The payloads below are then built by construction and their checksums computed
 * with the verified algorithm. An earlier version of this file hard-coded a BR
 * Code example from memory; the checksum did not match, and the algorithm — not
 * the example — was almost blamed.
 */

/**
 * Built with a TLV helper rather than by counting characters. Hand-written length
 * prefixes were wrong in an earlier version of this file, and a wrong prefix makes
 * the parser silently skip the field it was meant to read.
 */
function tlv(tag: string, value: string): string {
  return `${tag}${value.length.toString().padStart(2, '0')}${value}`;
}

function brCodeWithoutChecksum(amount?: string): string {
  const merchantAccount = tlv('00', 'BR.GOV.BCB.PIX') + tlv('01', '+5561999999999');

  return [
    tlv('00', '01'),
    tlv('26', merchantAccount),
    tlv('52', '0000'),
    tlv('53', '986'),
    amount === undefined ? '' : tlv('54', amount),
    tlv('58', 'BR'),
    tlv('59', 'Fulano de Tal'),
    tlv('60', 'BRASILIA'),
    tlv('62', tlv('05', '***')),
    '6304',
  ].join('');
}

const WITHOUT_AMOUNT = brCodeWithoutChecksum();
const WITH_AMOUNT = brCodeWithoutChecksum('10.00');

function sealed(payloadWithoutChecksum: string): string {
  return `${payloadWithoutChecksum}${computeBrCodeChecksum(payloadWithoutChecksum)}`;
}

describe('the CRC16 algorithm', () => {
  it('produces the published check value for CRC-16/CCITT-FALSE', () => {
    // The one assertion here that does not depend on anything in this repository.
    expect(computeBrCodeChecksum('123456789')).toBe('29B1');
  });

  it('always returns four uppercase hex digits', () => {
    for (const input of ['', 'a', '123456789', WITHOUT_AMOUNT]) {
      expect(computeBrCodeChecksum(input)).toMatch(/^[0-9A-F]{4}$/);
    }
  });
});

describe('verifying a sealed code', () => {
  it('accepts a code carrying the checksum it computes to', () => {
    expect(hasValidBrCodeChecksum(sealed(WITHOUT_AMOUNT))).toBe(true);
    expect(hasValidBrCodeChecksum(sealed(WITH_AMOUNT))).toBe(true);
  });

  it('rejects a single altered character anywhere in the payload', () => {
    // The check that catches a truncated or corrupted provider response before a
    // customer stares at a banking app that refuses to scan.
    const tampered = sealed(WITHOUT_AMOUNT).replace('Fulano de Tal', 'Fulana de Tal');
    expect(hasValidBrCodeChecksum(tampered)).toBe(false);
  });

  it('rejects a corrupted checksum field', () => {
    expect(hasValidBrCodeChecksum(`${WITHOUT_AMOUNT}0000`)).toBe(false);
  });

  it('rejects a truncated or empty payload', () => {
    expect(hasValidBrCodeChecksum(sealed(WITHOUT_AMOUNT).slice(0, -1))).toBe(false);
    expect(hasValidBrCodeChecksum('')).toBe(false);
  });

  it('accepts a lowercase checksum, which some providers emit', () => {
    const code = sealed(WITHOUT_AMOUNT);
    expect(hasValidBrCodeChecksum(code.slice(0, -4) + code.slice(-4).toLowerCase())).toBe(true);
  });
});

describe('reading the amount out of the code', () => {
  it('returns minor units without ever touching a float', () => {
    expect(readBrCodeAmountMinor(sealed(WITH_AMOUNT))).toBe(1000n);
  });

  it('returns undefined when the code declares no amount', () => {
    expect(readBrCodeAmountMinor(sealed(WITHOUT_AMOUNT))).toBeUndefined();
  });

  it('handles one decimal place and none at all', () => {
    expect(readBrCodeAmountMinor(brCodeWithoutChecksum('10.5'))).toBe(1050n);
    expect(readBrCodeAmountMinor(brCodeWithoutChecksum('10'))).toBe(1000n);
    expect(readBrCodeAmountMinor(brCodeWithoutChecksum('0.01'))).toBe(1n);
  });

  it('refuses a malformed amount rather than guessing', () => {
    const malformed = brCodeWithoutChecksum('1.2.3.4');
    expect(readBrCodeAmountMinor(malformed)).toBeUndefined();
  });
});

describe('the gate a code passes before a customer sees it', () => {
  it('accepts a well-formed code whose amount matches the payment', () => {
    expect(() => assertPresentableBrCode(sealed(WITH_AMOUNT), 1000n)).not.toThrow();
  });

  it('refuses a code that asks for a different amount than the payment', () => {
    // The worst failure mode of all: it scans perfectly and charges the wrong sum.
    expect(() => assertPresentableBrCode(sealed(WITH_AMOUNT), 9999n)).toThrow(
      /asks for 1000 minor units/,
    );
  });

  it('accepts a code with no amount, leaving the payer to enter one', () => {
    expect(() => assertPresentableBrCode(sealed(WITHOUT_AMOUNT), 5000n)).not.toThrow();
  });

  it('refuses an empty code', () => {
    expect(() => assertPresentableBrCode('', 1000n)).toThrow(InvalidBrCodeError);
  });

  it('refuses a code that is not a Pix code at all', () => {
    const notPix = sealed(
      tlv('00', '01') + tlv('26', tlv('00', 'BR.GOV.OTHER.XX')) + tlv('58', 'BR') + '6304',
    );
    expect(() => assertPresentableBrCode(notPix, 1000n)).toThrow(/br\.gov\.bcb\.pix/);
  });

  it('refuses a code whose checksum does not verify', () => {
    const tampered = sealed(WITHOUT_AMOUNT).replace('BRASILIA', 'SAOPAULO');
    expect(() => assertPresentableBrCode(tampered, 1000n)).toThrow(/CRC16/);
  });
});

describe('inspecting a code', () => {
  it('reports every property at once', () => {
    expect(inspectBrCode(sealed(WITH_AMOUNT))).toEqual({
      hasValidChecksum: true,
      declaresPixDomain: true,
      amountMinor: 1000n,
    });
  });

  it('reports a failing checksum without throwing', () => {
    expect(inspectBrCode(`${WITH_AMOUNT}0000`).hasValidChecksum).toBe(false);
  });
});
