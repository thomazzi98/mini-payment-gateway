import type { PixInstrument } from '../../../application/ports/payment-provider.js';

/**
 * Reading a Pix instrument out of an Appmax response.
 *
 * Appmax's own documentation describes this response two different ways, and both
 * are handled because there is no way to know from here which one a given account
 * will return:
 *
 *   data.pix.{ qr_code, emv_code, expires_at }
 *   data.payment.{ pix_qrcode, pix_emv, pix_expiration_date }
 *
 * It also documents the QR image as base64 both with and without a `data:` prefix.
 *
 * Guessing wrong means a customer with no code to pay, so this reads every
 * documented location, reports which shape it found for telemetry, and refuses
 * rather than inventing a value when it finds none.
 */

export class UnreadableAppmaxPixResponseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UnreadableAppmaxPixResponseError';
  }
}

type PixResponseShape = 'data.pix' | 'data.payment' | 'mixed';

export interface NormalizedPixResponse {
  readonly instrument: PixInstrument;
  /**
   * Recorded so a change on Appmax's side shows up in telemetry, not in an outage.
   */
  readonly shape: PixResponseShape;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const DATA_URI_PREFIX = 'data:image';

/**
 * Appmax documents the QR image with and without the data URI prefix, so the
 * prefix is added when missing. A raw base64 blob in an <img src> renders nothing.
 */
function canonicalizeQrImage(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.startsWith(DATA_URI_PREFIX)) {
    return value;
  }
  return `data:image/png;base64,${value}`;
}

/**
 * Appmax returns "Y-m-d H:i:s" with no zone. It is Brazilian, so it is read as
 * America/Sao_Paulo rather than as UTC; reading it as UTC would place expiry three
 * hours early and expire live codes.
 */
const BRAZIL_UTC_OFFSET = '-03:00';
const NAIVE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})$/;

export function parseAppmaxTimestamp(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  const naive = NAIVE_TIMESTAMP.exec(value);
  const candidate =
    naive === null ? new Date(value) : new Date(`${naive[1]}T${naive[2]}${BRAZIL_UTC_OFFSET}`);

  return Number.isNaN(candidate.getTime()) ? undefined : candidate;
}

export function normalizePixResponse(body: unknown): NormalizedPixResponse {
  const data = asRecord(asRecord(body)?.['data']);
  if (data === undefined) {
    throw new UnreadableAppmaxPixResponseError('The Appmax response carried no data object.');
  }

  const pixShape = asRecord(data['pix']);
  const paymentShape = asRecord(data['payment']);
  const copyAndPasteCode = readString(pixShape, 'emv_code') ?? readString(paymentShape, 'pix_emv');

  if (copyAndPasteCode === undefined) {
    throw new UnreadableAppmaxPixResponseError(
      'The Appmax response carried no Pix copy-and-paste code in any documented location.',
    );
  }

  const qrCodeImage = readString(pixShape, 'qr_code') ?? readString(paymentShape, 'pix_qrcode');
  const expiry =
    readString(pixShape, 'expires_at') ?? readString(paymentShape, 'pix_expiration_date');

  return {
    instrument: {
      copyAndPasteCode,
      qrCodeImageDataUri: canonicalizeQrImage(qrCodeImage),
      expiresAt: parseAppmaxTimestamp(expiry),
    },
    shape: shapeOf(pixShape, paymentShape),
  };
}

function shapeOf(
  pixShape: Record<string, unknown> | undefined,
  paymentShape: Record<string, unknown> | undefined,
): PixResponseShape {
  const hasPix = readString(pixShape, 'emv_code') !== undefined;
  const hasPayment = readString(paymentShape, 'pix_emv') !== undefined;

  if (hasPix && hasPayment) {
    return 'mixed';
  }
  return hasPix ? 'data.pix' : 'data.payment';
}

/**
 * Appmax identifies everything by its order, so that is the correlation key.
 */
export function readOrderReference(body: unknown): string | undefined {
  const data = asRecord(asRecord(body)?.['data']);
  const order = asRecord(data?.['order']);
  const identifier = order?.['id'] ?? data?.['order_id'];

  if (typeof identifier === 'number' && Number.isSafeInteger(identifier)) {
    return identifier.toString();
  }
  if (typeof identifier === 'string' && identifier.trim().length > 0) {
    return identifier.trim();
  }
  return undefined;
}
