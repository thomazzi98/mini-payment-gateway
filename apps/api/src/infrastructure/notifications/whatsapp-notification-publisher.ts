import { Agent, request } from 'undici';
import type { Secret } from '@gateway/shared/server';
import type {
  NotificationOutcome,
  PaidNotification,
  PaymentPaidNotifier,
} from '../../application/ports/payment-notifier.js';

/**
 * Hands a paid notification to the WhatsApp Notification Platform.
 *
 * One request: `POST /v1/notifications` with the event id as the idempotency
 * key. The platform answers 202 because it has accepted the message, not
 * delivered it; delivery, pacing and retries towards WhatsApp are its own, and
 * what this gateway records is that the hand-over happened durably and once.
 *
 * Nothing about the outcome of this call can reach a payment. A platform that is
 * down defers the event; the payment it describes was paid before this ran.
 */

export interface NotificationPublisherLogger {
  debug(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

const NOTIFICATIONS_PATH = '/v1/notifications';
const JSON_CONTENT_TYPE = 'application/json';

/**
 * Statuses that will not change on a retry. A 4xx says the platform understood
 * the request and declined it: a malformed recipient, an unknown key. Sending
 * the same bytes again tomorrow would be declined the same way. 408 and 429 are
 * the exceptions, and are retried.
 */
function isPermanentRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function notificationIdOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function summarizeRefusal(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return 'no detail';
  }
  const candidate = body as { code?: unknown; title?: unknown; message?: unknown };
  for (const field of [candidate.code, candidate.title, candidate.message]) {
    if (typeof field === 'string' && field !== '') {
      return field;
    }
  }
  return 'no detail';
}

export class WhatsAppNotificationPublisher implements PaymentPaidNotifier {
  private readonly agent: Agent;

  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: Secret,
    private readonly logger: NotificationPublisherLogger,
    timeoutMilliseconds = 10_000,
  ) {
    this.agent = new Agent({
      connectTimeout: timeoutMilliseconds,
      headersTimeout: timeoutMilliseconds,
      bodyTimeout: timeoutMilliseconds,
    });
  }

  public async notify(notification: PaidNotification): Promise<NotificationOutcome> {
    const startedAt = process.hrtime.bigint();
    let status: number;
    let body: unknown;
    try {
      const response = await request(`${this.baseUrl}${NOTIFICATIONS_PATH}`, {
        method: 'POST',
        dispatcher: this.agent,
        headers: {
          authorization: `Bearer ${this.apiKey.expose()}`,
          'content-type': JSON_CONTENT_TYPE,
          accept: JSON_CONTENT_TYPE,
          'idempotency-key': notification.eventId,
        },
        body: JSON.stringify({
          recipient: notification.recipient,
          body: notification.message,
          metadata: notification.metadata,
        }),
      });
      status = response.statusCode;
      const text = await response.body.text();
      body = parseJson(text);
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code ?? 'unknown';
      return {
        kind: 'retry',
        reason: `The notification platform could not be reached (${code}).`,
      };
    }

    this.logger.debug(
      {
        eventId: notification.eventId,
        httpStatus: status,
        durationMilliseconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      },
      'whatsapp notification request completed',
    );

    if (status >= 200 && status < 300) {
      const reference = notificationIdOf(body);
      if (reference === undefined) {
        // Accepted, but with no identifier to record. Treated as unresolved:
        // the idempotency key makes asking again harmless, and the answer to
        // "was it accepted" must not be guessed from a body nobody can read.
        return {
          kind: 'retry',
          reason: 'The notification platform accepted the message without an identifier.',
        };
      }
      return { kind: 'accepted', reference };
    }

    const summary = summarizeRefusal(body);
    if (isPermanentRefusal(status)) {
      this.logger.warn(
        { eventId: notification.eventId, httpStatus: status, refusal: summary },
        'the notification platform refused a paid notification',
      );
      return {
        kind: 'refused',
        reason: `The notification platform refused the message (${status.toString()}: ${summary}).`,
      };
    }
    return {
      kind: 'retry',
      reason: `The notification platform answered ${status.toString()} (${summary}).`,
    };
  }
}

function parseJson(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
