import { createHash } from 'node:crypto';
import type {
  ProviderWebhookParse,
  ProviderWebhookReceiver,
} from '../../../application/ports/provider-webhook.js';
import { requiresProviderRead } from './appmax-mappings.js';
import { APPMAX_PROVIDER_CODE } from './appmax-provider.js';

/**
 * Appmax notifications.
 *
 * ## What is known, and what is not
 *
 * Appmax documents that its webhooks carry **no signature and no authentication
 * token of any kind**, that a receiver must answer within five seconds, and that
 * delivery is abandoned after four attempts. Those facts are why this gateway
 * treats a notification as a prompt rather than as evidence, and they are the
 * reason a forged notification cannot move money: the database refuses a funded
 * transition on anything short of an authenticated read.
 *
 * The **envelope shape is not verified**. The event names below are documented,
 * but the exact JSON layout Appmax posts has not been confirmed against a real
 * delivery, because that requires a developer account this project does not have.
 * So the parser reads defensively from the layouts the documentation implies and
 * refuses anything it cannot recognise, rather than asserting one shape is the
 * shape. When a real delivery is available, the fixtures here are what to check
 * it against. See docs/limitations.md.
 *
 * Nothing about this uncertainty is load-bearing for correctness. A notification
 * this parser misreads produces, at worst, no read being scheduled — the payment
 * is still polled on its ordinary cadence and still resolved by an authenticated
 * inquiry.
 */

interface AppmaxEnvelope {
  readonly event?: unknown;
  readonly data?: unknown;
  readonly id?: unknown;
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  // Appmax order identifiers are numeric in its own examples, and JSON does not
  // distinguish "3531" from 3531. Both name the same order.
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return undefined;
}

function readOrderReference(payload: AppmaxEnvelope): string | undefined {
  const data = payload.data;
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }

  const fields = data as Record<string, unknown>;
  // `id` is the order in Appmax's own order payloads; `order_id` appears in its
  // payment examples. Both are read because the documentation uses both and
  // neither has been seen on the wire.
  return readString(fields['id']) ?? readString(fields['order_id']);
}

export class AppmaxWebhookReceiver implements ProviderWebhookReceiver {
  public readonly providerCode = APPMAX_PROVIDER_CODE;

  /**
   * Documented by Appmax as sending no signature. Stated as a fact rather than
   * implemented as an always-true check, so nothing reads as verification that
   * is not verification.
   */
  public readonly signsNotifications = false;

  public verify(): boolean {
    // There is nothing to verify. Inventing an HMAC here would produce a check
    // that always passed while looking like security, which is worse than the
    // honest absence: the endpoint is protected by an unguessable path instead,
    // and the payment is protected by the evidence rule regardless.
    return true;
  }

  public parse(rawBody: Buffer): ProviderWebhookParse {
    let payload: AppmaxEnvelope;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as AppmaxEnvelope;
    } catch {
      return { kind: 'unreadable', reason: 'The notification body is not JSON.' };
    }

    if (typeof payload !== 'object' || payload === null) {
      return { kind: 'unreadable', reason: 'The notification body is not an object.' };
    }

    const eventType = readString(payload.event);
    if (eventType === undefined) {
      return { kind: 'unreadable', reason: 'The notification names no event.' };
    }

    return {
      kind: 'parsed',
      event: {
        eventId: readString(payload.id) ?? derivedEventId(eventType, rawBody),
        eventType,
        providerReference: readOrderReference(payload),
        requiresRead: requiresProviderRead(eventType),
      },
    };
  }
}

/**
 * A stable identity for a delivery the provider did not identify.
 *
 * Appmax is not documented to send a delivery id, so one is derived from what it
 * did send. A redelivery of the same notification hashes the same and dedupes; a
 * genuinely new notification differs somewhere and does not. Deriving it from the
 * raw bytes rather than from parsed fields means two deliveries are the same only
 * when they are byte-identical.
 */
function derivedEventId(eventType: string, rawBody: Buffer): string {
  const digest = createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
  return `derived:${eventType}:${digest}`;
}
