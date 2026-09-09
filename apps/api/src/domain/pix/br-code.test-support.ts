import { computeBrCodeChecksum } from './br-code.js';

/**
 * Builds real, checksum-valid BR Codes for tests.
 *
 * Hand-written constants would be copied between test files and drift; worse, a
 * wrong one looks exactly like a bug in the checksum. Codes are assembled here
 * from the same TLV rules the parser reads, so a test that expects a payable code
 * gets a payable code.
 */

function tlv(tag: string, value: string): string {
  return `${tag}${value.length.toString().padStart(2, '0')}${value}`;
}

/**
 * @param amount The tag-54 amount, in major units as the specification writes it.
 */
export function payableBrCode(amount: string): string {
  const withoutChecksum = [
    tlv('00', '01'),
    tlv('26', tlv('00', 'BR.GOV.BCB.PIX') + tlv('01', '+5561999999999')),
    tlv('53', '986'),
    tlv('54', amount),
    tlv('58', 'BR'),
    tlv('59', 'Merchant'),
    '6304',
  ].join('');
  return `${withoutChecksum}${computeBrCodeChecksum(withoutChecksum)}`;
}
