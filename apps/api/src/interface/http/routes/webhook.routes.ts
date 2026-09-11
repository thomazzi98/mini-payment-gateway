import { timingSafeEqual } from 'node:crypto';
import { ingestProviderWebhook } from '../../../application/ingest-provider-webhook.use-case.js';
import type { WebhookIngestionDependencies } from '../../../application/ingest-provider-webhook.use-case.js';
import type { Secret } from '@gateway/shared/server';
import { apiError } from '../errors.js';
import type { ApplicationServer } from '../server-types.js';

/**
 * Where a provider tells us something happened.
 *
 * The endpoint decides nothing about money. It records the notification, finds
 * the payment, and brings that payment's next inquiry forward; an authenticated
 * read decides what is true. The database enforces that separation — a funded
 * transition demands `authenticated_provider_read` — so this route could not fund
 * a payment even if it tried.
 *
 * Appmax sends no signature and no token of any kind, which it documents. The
 * endpoint is therefore protected by being unguessable: the path carries a secret
 * chosen by us and configured as the notification URL. That is our own shared
 * secret, not a pretence at verifying a provider signature scheme that does not
 * exist. It bounds who can cause a provider call; it is not what protects the
 * money, and it is not treated as though it were.
 */

export interface WebhookRouteDependencies {
  readonly appmax: WebhookIngestionDependencies;
  /**
   * CryptoPay signs every notification, so its endpoint needs no secret in the
   * path: the signature is verified against the raw bytes before anything is
   * read, and one that does not verify is refused. The notification is still
   * never evidence; it schedules the same authenticated read Appmax's does.
   */
  readonly cryptopay: WebhookIngestionDependencies;
  /**
   * The unguessable segment of the notification URL, as configured with the
   * provider.
   */
  readonly pathSecret: Secret;
}

/**
 * Appmax abandons delivery after four attempts, so a slow answer is a lost
 * notification. Nothing here calls a provider; two writes and a reply.
 */
export function registerWebhookRoutes(
  server: ApplicationServer,
  dependencies: WebhookRouteDependencies,
): void {
  // Encapsulated so the raw-body parser applies here and nowhere else. Every
  // other route keeps parsed JSON; this one needs the bytes as sent, because a
  // signature covers what was sent and a re-serialised object is a
  // reconstruction. Appmax signs nothing today, and the next provider might.
  void server.register((scope, _options, done) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.post<{ Params: { secret: string }; Body: unknown }>(
      '/v1/webhooks/appmax/:secret',
      async (request, reply) => {
        const requestId = request.id;

        if (!isExpectedSecret(request.params.secret, dependencies.pathSecret)) {
          request.log.warn(
            { providerCode: 'appmax' },
            'a notification arrived on an unrecognised webhook path',
          );
          // The same answer as any other unknown path. Confirming that the endpoint
          // exists but the secret is wrong would tell an attacker they had found
          // the right shape and only needed the secret.
          return reply.code(404).send(
            apiError({
              httpStatus: 404,
              type: 'invalid_request_error',
              code: 'not_found',
              message: 'No such endpoint.',
              requestId,
            }).body,
          );
        }

        return ingest(request, reply, dependencies.appmax);
      },
    );

    scope.post<{ Body: unknown }>('/v1/webhooks/cryptopay', async (request, reply) =>
      ingest(request, reply, dependencies.cryptopay),
    );
    done();
  });
}

async function ingest(
  request: {
    readonly id: string;
    readonly body: unknown;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly log: { info(details: Record<string, unknown>, message: string): void };
  },
  reply: { code(status: number): { send(body: unknown): unknown } },
  ingestion: WebhookIngestionDependencies,
): Promise<unknown> {
  const requestId = request.id;
  const rawBody = rawBodyOf(request.body);
  const outcome = await ingestProviderWebhook(rawBody, headersOf(request), ingestion);

  request.log.info(
    {
      providerCode: ingestion.receiver.providerCode,
      outcome: outcome.kind,
      ...('paymentId' in outcome && { paymentId: outcome.paymentId }),
    },
    'provider notification received',
  );

  if (outcome.kind === 'unreadable') {
    // 400, and nothing else. A body this provider does not send, or a signature
    // that does not verify, is a caller error, and repeating it back would echo
    // unvalidated content.
    return reply.code(400).send(
      apiError({
        httpStatus: 400,
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: 'The notification could not be read.',
        requestId,
      }).body,
    );
  }

  // Everything the provider can legitimately send answers the same way, so a
  // sender learns nothing from the reply about whether a payment exists, whether
  // it was already known, or whom it belongs to. Providers retry on anything
  // other than a success, and there is nothing here worth retrying.
  return reply.code(202).send({ received: true });
}

/**
 * Constant time, and length-safe.
 *
 * A comparison that returns early on the first differing byte leaks the secret
 * one byte at a time to anyone who can measure the reply.
 */
function isExpectedSecret(presented: string, expected: Secret): boolean {
  const presentedBytes = Buffer.from(presented, 'utf8');
  const expectedBytes = Buffer.from(expected.expose(), 'utf8');

  if (presentedBytes.length !== expectedBytes.length) {
    return false;
  }
  return timingSafeEqual(presentedBytes, expectedBytes);
}

function rawBodyOf(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }
  return Buffer.from(JSON.stringify(body ?? null), 'utf8');
}

function headersOf(request: {
  readonly headers: Record<string, string | string[] | undefined>;
}): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}
