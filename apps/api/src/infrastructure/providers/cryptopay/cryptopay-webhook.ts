import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Secret } from '@gateway/shared/server';
import type {
  ProviderWebhookParse,
  ProviderWebhookReceiver,
} from '../../../application/ports/provider-webhook.js';
import { CRYPTOPAY_PROVIDER_CODE } from './cryptopay-provider.js';

/**
 * CryptoPay notifications, verified as Standard Webhooks.
 *
 * The signed content is `{webhook-id}.{webhook-timestamp}.{raw body}`, HMAC-SHA256
 * with the decoded bytes of a `whsec_` secret, presented as space-separated
 * `v1,<base64>` values. Verification is against the bytes as received, never a
 * re-serialised object, because key order and whitespace are part of what was
 * signed.
 *
 * A notification that verifies is still not evidence. It brings the payment's
 * next authenticated read forward, and the read decides; the database refuses to
 * fund a payment on anything less. The signature bounds who can cause a read.
 */

const SIGNATURE_VERSION = 'v1';
const SECRET_PREFIX = 'whsec_';
const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Events whose arrival could change what the gateway believes. The rest are
 * recorded and not acted on; a `confirming` event says the money is not final
 * yet, and asking about it would only be told the same.
 */
const EVENTS_REQUIRING_READ: ReadonlySet<string> = new Set([
  'payment.completed',
  'payment.overpaid',
  'payment.underpaid',
  'payment.expired',
  'payment.canceled',
]);

function decodeSecret(secret: string): Buffer {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return Buffer.from(encoded, 'base64');
}

function isEqualInConstantTime(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

export interface CryptoPayWebhookOptions {
  readonly toleranceSeconds?: number;
  readonly now?: () => number;
}

export class CryptoPayWebhookReceiver implements ProviderWebhookReceiver {
  private readonly toleranceSeconds: number;

  private readonly now: () => number;

  public readonly providerCode = CRYPTOPAY_PROVIDER_CODE;

  public readonly signsNotifications = true;

  /**
   * Several secrets are accepted so a rotation on CryptoPay's side can overlap:
   * both sign during the grace period, and this side keeps verifying with
   * whichever it has.
   */
  public constructor(
    private readonly secrets: readonly Secret[],
    options: CryptoPayWebhookOptions = {},
  ) {
    this.toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  public verify(rawBody: Buffer, headers: Readonly<Record<string, string | undefined>>): boolean {
    const identifier = headers['webhook-id'];
    const timestampHeader = headers['webhook-timestamp'];
    const signatureHeader = headers['webhook-signature'];
    if (
      identifier === undefined ||
      identifier === '' ||
      timestampHeader === undefined ||
      signatureHeader === undefined ||
      signatureHeader === ''
    ) {
      return false;
    }

    const timestamp = Number(timestampHeader);
    if (!Number.isSafeInteger(timestamp)) {
      return false;
    }
    // Bounded in both directions, against now rather than against the event: the
    // timestamp is regenerated on every attempt, so a retry days later still
    // verifies, while a captured request does not stay replayable forever.
    if (Math.abs(this.now() - timestamp) > this.toleranceSeconds) {
      return false;
    }

    const presented = signatureHeader
      .split(' ')
      .filter((entry) => entry.startsWith(`${SIGNATURE_VERSION},`))
      .map((entry) => entry.slice(SIGNATURE_VERSION.length + 1));
    if (presented.length === 0) {
      return false;
    }

    const signedContent = `${identifier}.${timestamp.toString()}.${rawBody.toString('utf8')}`;

    // Every candidate is compared and the loop never exits early, so the time
    // taken does not depend on which secret or signature happened to match.
    let isMatched = false;
    for (const secret of this.secrets) {
      const expected = createHmac('sha256', decodeSecret(secret.expose()))
        .update(signedContent)
        .digest('base64');
      for (const candidate of presented) {
        isMatched = isEqualInConstantTime(expected, candidate) || isMatched;
      }
    }
    return isMatched;
  }

  public parse(rawBody: Buffer): ProviderWebhookParse {
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { kind: 'unreadable', reason: 'The notification body is not JSON.' };
    }
    if (typeof body !== 'object' || body === null) {
      return { kind: 'unreadable', reason: 'The notification body is not an object.' };
    }

    const envelope = body as { identifier?: unknown; type?: unknown; data?: unknown };
    if (typeof envelope.identifier !== 'string' || envelope.identifier === '') {
      return { kind: 'unreadable', reason: 'The notification carries no event identifier.' };
    }
    if (typeof envelope.type !== 'string' || !envelope.type.startsWith('payment.')) {
      return { kind: 'unreadable', reason: 'The notification is not a payment event.' };
    }

    const data = envelope.data as { identifier?: unknown } | undefined;
    const providerReference =
      typeof data?.identifier === 'string' && data.identifier !== '' ? data.identifier : undefined;

    return {
      kind: 'parsed',
      event: {
        // The envelope identifier is the same value as the webhook-id header and
        // is stable across every retry and redelivery, which is what makes it the
        // deduplication key rather than the payment identifier.
        eventId: envelope.identifier,
        eventType: envelope.type,
        providerReference,
        requiresRead: EVENTS_REQUIRING_READ.has(envelope.type),
      },
    };
  }
}
