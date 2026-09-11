import { Secret } from '@gateway/shared/server';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type {
  MatchedPayment,
  WebhookIngestionStore,
} from '../../../application/ports/provider-webhook.repository.js';
import type { ProviderWebhookReceiver } from '../../../application/ports/provider-webhook.js';
import { registerErrorHandling } from '../error-handling.js';
import { registerWebhookRoutes } from './webhook.routes.js';
import type { ApplicationServer } from '../server-types.js';

/**
 * Drives the route through Fastify's injector, so the real routing, the raw-body
 * parser and the secret comparison all run.
 */

const SECRET = 'a-webhook-path-secret-for-tests';
const MATCHED: MatchedPayment = { paymentId: 'internal-1', organizationId: 'organization-1' };

interface Harness {
  readonly server: ApplicationServer;
  readonly broughtForward: string[];
  readonly recorded: unknown[];
}

function receiver(): ProviderWebhookReceiver {
  return {
    providerCode: 'appmax',
    signsNotifications: false,
    verify: () => true,
    parse: (rawBody) => {
      let payload: { event?: string; data?: { id?: string | number } };
      try {
        payload = JSON.parse(rawBody.toString('utf8')) as typeof payload;
      } catch {
        return { kind: 'unreadable', reason: 'not json' };
      }
      if (payload?.event === undefined) {
        return { kind: 'unreadable', reason: 'names no event' };
      }
      return {
        kind: 'parsed',
        event: {
          eventId: `derived:${rawBody.toString('utf8')}`,
          eventType: payload.event,
          providerReference: payload.data?.id === undefined ? undefined : String(payload.data.id),
          requiresRead: true,
        },
      };
    },
  };
}

function buildHarness(options: { match?: MatchedPayment; duplicate?: boolean } = {}): Harness {
  const broughtForward: string[] = [];
  const recorded: unknown[] = [];

  const store: WebhookIngestionStore = {
    findPaymentByProviderReference: () => Promise.resolve(options.match),
    recordEvent: (event) => {
      recorded.push(event);
      return Promise.resolve(options.duplicate === true ? 'duplicate' : 'recorded');
    },
    bringInquiryForward: (paymentId) => {
      broughtForward.push(paymentId);
      return Promise.resolve();
    },
  };

  const server = Fastify() as unknown as ApplicationServer;
  registerErrorHandling(server);
  registerWebhookRoutes(server, {
    appmax: { receiver: receiver(), store },
    cryptopay: { receiver: receiver(), store },
    pathSecret: new Secret(SECRET),
  });

  return { server, broughtForward, recorded };
}

async function post(
  harness: Harness,
  options: { secret?: string; body?: string } = {},
): Promise<Awaited<ReturnType<ApplicationServer['inject']>>> {
  return harness.server.inject({
    method: 'POST',
    url: `/v1/webhooks/appmax/${options.secret ?? SECRET}`,
    headers: { 'content-type': 'application/json' },
    payload: options.body ?? JSON.stringify({ event: 'order_paid_by_pix', data: { id: 3531 } }),
  });
}

/**
 * Everything a refusal says apart from the request id, which legitimately differs
 * per request. What must not differ is anything a prober could learn from.
 */
function refusalWithoutRequestId(response: { json: <T>() => T }): Record<string, unknown> {
  const { error } = response.json<{ error: Record<string, unknown> }>();
  const rest: Record<string, unknown> = { ...error };
  delete rest['requestId'];
  return rest;
}

describe('reaching the endpoint at all', () => {
  it('accepts a notification on the configured path', async () => {
    const harness = buildHarness({ match: MATCHED });
    const response = await post(harness);

    expect(response.statusCode).toBe(202);
    expect(harness.broughtForward).toEqual(['internal-1']);
  });

  it('refuses a wrong secret exactly as it refuses an unknown path', async () => {
    // Confirming the endpoint exists but the secret is wrong would tell an
    // attacker they had found the right shape and needed only the secret.
    const harness = buildHarness({ match: MATCHED });
    const wrongSecret = await post(harness, { secret: 'not-the-secret-but-same-length!' });
    const unknownPath = await harness.server.inject({ method: 'POST', url: '/v1/webhooks/nope' });

    expect(wrongSecret.statusCode).toBe(404);
    expect(unknownPath.statusCode).toBe(404);

    expect(refusalWithoutRequestId(wrongSecret)).toEqual(refusalWithoutRequestId(unknownPath));
  });

  it('does nothing at all when the secret is wrong', async () => {
    const harness = buildHarness({ match: MATCHED });
    await post(harness, { secret: 'wrong' });

    expect(harness.recorded).toEqual([]);
    expect(harness.broughtForward).toEqual([]);
  });

  it('refuses a secret that is a prefix of the real one', async () => {
    const harness = buildHarness({ match: MATCHED });
    const response = await post(harness, { secret: SECRET.slice(0, -1) });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a secret that merely starts with the real one', async () => {
    const harness = buildHarness({ match: MATCHED });
    const response = await post(harness, { secret: `${SECRET}extra` });

    expect(response.statusCode).toBe(404);
  });
});

describe('what the reply tells a sender', () => {
  it('answers the same whether the payment is known or not', async () => {
    // A sender must not be able to use the endpoint to discover which provider
    // references this gateway holds.
    const known = await post(buildHarness({ match: MATCHED }));
    const unknown = await post(buildHarness({}));

    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.body).toBe(unknown.body);
  });

  it('answers the same on a redelivery as on the first delivery', async () => {
    const first = await post(buildHarness({ match: MATCHED }));
    const repeat = await post(buildHarness({ match: MATCHED, duplicate: true }));

    expect(repeat.statusCode).toBe(first.statusCode);
    expect(repeat.body).toBe(first.body);
  });

  it('has no second effect on a redelivery', async () => {
    const harness = buildHarness({ match: MATCHED, duplicate: true });
    await post(harness);

    expect(harness.broughtForward).toEqual([]);
  });

  it('refuses a body the provider does not send, without echoing it', async () => {
    const harness = buildHarness({ match: MATCHED });
    const response = await post(harness, { body: '{"totally":"unexpected","secret":"hunter2"}' });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('totally');
  });

  it('refuses a body that is not JSON', async () => {
    const harness = buildHarness({ match: MATCHED });
    const response = await post(harness, { body: '<html>nope</html>' });

    expect(response.statusCode).toBe(400);
    expect(harness.recorded).toEqual([]);
  });

  it('never reports a payment status, because it never decides one', async () => {
    const harness = buildHarness({ match: MATCHED });
    const response = await post(harness);

    expect(response.json()).toEqual({ received: true });
    for (const forbidden of ['paid', 'status', 'amount', 'organization']) {
      expect(response.body).not.toContain(forbidden);
    }
  });
});

describe('the raw body reaches the receiver', () => {
  it('hands over the bytes as sent rather than a re-serialisation', async () => {
    // Key order and whitespace are part of what a signature covers. Fastify would
    // otherwise parse and the route would re-serialise something different.
    let seen: string | undefined;
    const spy: ProviderWebhookReceiver = {
      providerCode: 'appmax',
      signsNotifications: true,
      verify: (rawBody) => {
        seen = rawBody.toString('utf8');
        return true;
      },
      parse: () => ({ kind: 'unreadable', reason: 'not needed' }),
    };

    const server = Fastify() as unknown as ApplicationServer;
    registerErrorHandling(server);
    const ingestion = {
      receiver: spy,
      store: {
        findPaymentByProviderReference: () => Promise.resolve(undefined),
        recordEvent: () => Promise.resolve('recorded' as const),
        bringInquiryForward: () => Promise.resolve(),
      },
    };
    registerWebhookRoutes(server, {
      appmax: ingestion,
      cryptopay: ingestion,
      pathSecret: new Secret(SECRET),
    });

    const body = '{  "event" : "order_paid" ,  "data" : { "id" : 3531 }  }';
    await server.inject({
      method: 'POST',
      url: `/v1/webhooks/appmax/${SECRET}`,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });

    expect(seen).toBe(body);
  });
});
