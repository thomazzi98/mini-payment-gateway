import { describe, expect, it } from 'vitest';
import { ingestProviderWebhook } from './ingest-provider-webhook.use-case.js';
import type { WebhookIngestionDependencies } from './ingest-provider-webhook.use-case.js';
import type { MatchedPayment, WebhookIngestionStore } from './ports/provider-webhook.repository.js';
import type { ProviderWebhookReceiver } from './ports/provider-webhook.js';

/**
 * The property under test throughout: a notification can bring an inquiry
 * forward and can do nothing else. It never decides anything about money, and it
 * can never be aimed at a payment whose provider reference it does not carry.
 */

const MATCHED: MatchedPayment = { paymentId: 'internal-1', organizationId: 'organization-1' };

interface Recorded {
  readonly events: {
    providerEventId: string;
    eventType: string;
    disposition: string;
    paymentId: string | undefined;
  }[];
  readonly broughtForward: string[];
  readonly lookups: { providerCode: string; providerReference: string }[];
}

function storeFor(options: {
  match?: MatchedPayment;
  duplicate?: boolean;
}): WebhookIngestionStore & { readonly calls: Recorded } {
  const calls: Recorded = { events: [], broughtForward: [], lookups: [] };
  return {
    calls,
    findPaymentByProviderReference: (providerCode, providerReference) => {
      calls.lookups.push({ providerCode, providerReference });
      return Promise.resolve(options.match);
    },
    recordEvent: (event) => {
      calls.events.push({
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        disposition: event.disposition,
        paymentId: event.paymentId,
      });
      return Promise.resolve(options.duplicate === true ? 'duplicate' : 'recorded');
    },
    bringInquiryForward: (paymentId) => {
      calls.broughtForward.push(paymentId);
      return Promise.resolve();
    },
  };
}

/**
 * A stand-in receiver, described only in the port's vocabulary. Naming a real
 * adapter here would make the application layer depend on infrastructure, which
 * is the coupling the lint boundary exists to prevent. The Appmax parser has its
 * own tests, next to the Appmax adapter.
 */
function receiverFor(events: Record<string, { requiresRead: boolean }>): ProviderWebhookReceiver {
  return {
    providerCode: 'test-provider',
    signsNotifications: false,
    verify: () => true,
    parse: (rawBody) => {
      let payload: { event?: string; id?: string; data?: { id?: string | number } };
      try {
        payload = JSON.parse(rawBody.toString('utf8')) as typeof payload;
      } catch {
        return { kind: 'unreadable', reason: 'not json' };
      }
      if (typeof payload !== 'object' || payload === null || payload.event === undefined) {
        return { kind: 'unreadable', reason: 'names no event' };
      }
      const reference = payload.data?.id;
      return {
        kind: 'parsed',
        event: {
          eventId: payload.id ?? `derived:${rawBody.toString('utf8')}`,
          eventType: payload.event,
          providerReference: reference === undefined ? undefined : String(reference),
          requiresRead: events[payload.event]?.requiresRead ?? true,
        },
      };
    },
  };
}

const DEFAULT_RECEIVER = receiverFor({ instrument_created: { requiresRead: false } });

function dependenciesFor(
  store: WebhookIngestionStore,
  receiver: ProviderWebhookReceiver = DEFAULT_RECEIVER,
): WebhookIngestionDependencies {
  return { receiver, store };
}

function bodyFor(event: string, orderId: unknown): Buffer {
  return Buffer.from(JSON.stringify({ event, data: { id: orderId } }), 'utf8');
}

describe('a notification about a payment we know', () => {
  it('records it and brings the payment’s inquiry forward', async () => {
    const store = storeFor({ match: MATCHED });
    const outcome = await ingestProviderWebhook(
      bodyFor('order_paid_by_pix', 3531),
      {},
      dependenciesFor(store),
    );

    expect(outcome).toEqual({ kind: 'scheduled_read', paymentId: 'internal-1' });
    expect(store.calls.broughtForward).toEqual(['internal-1']);
    expect(store.calls.events[0]?.disposition).toBe('scheduled_read');
  });

  it('finds the payment through the provider reference it carries', async () => {
    // Ownership comes from the reference. There is no merchant, organization or
    // payment id in the payload to be trusted, so there is nothing to forge.
    const store = storeFor({ match: MATCHED });
    await ingestProviderWebhook(bodyFor('order_paid', '3531'), {}, dependenciesFor(store));

    expect(store.calls.lookups).toEqual([
      { providerCode: 'test-provider', providerReference: '3531' },
    ]);
  });

  it('never decides the payment is paid, whatever the event says', async () => {
    // The notification is unauthenticated. The only effect permitted is that a
    // question gets asked sooner.
    const store = storeFor({ match: MATCHED });
    const outcome = await ingestProviderWebhook(
      bodyFor('order_paid_by_pix', 3531),
      {},
      dependenciesFor(store),
    );

    expect(outcome.kind).toBe('scheduled_read');
    expect(Object.keys(outcome)).not.toContain('status');
  });

  it('records but does not read on an event that cannot change anything', async () => {
    // An event the adapter reports as unable to change anything: the instrument
    // already existed as far as we were concerned. Reading on it would be a
    // provider call for nothing.
    const store = storeFor({ match: MATCHED });
    const outcome = await ingestProviderWebhook(
      bodyFor('instrument_created', 3531),
      {},
      dependenciesFor(store),
    );

    expect(outcome.kind).toBe('ignored');
    expect(store.calls.broughtForward).toEqual([]);
    expect(store.calls.events[0]?.disposition).toBe('ignored');
  });
});

describe('a notification about something we do not know', () => {
  it('is recorded and acted on in no way', async () => {
    const store = storeFor({});
    const outcome = await ingestProviderWebhook(
      bodyFor('order_paid_by_pix', 999_999),
      {},
      dependenciesFor(store),
    );

    expect(outcome).toEqual({ kind: 'unmatched' });
    expect(store.calls.broughtForward).toEqual([]);
    // Kept, because an event about something unrecognised is worth having when
    // somebody asks later why nothing happened.
    expect(store.calls.events[0]?.disposition).toBe('unmatched');
  });

  it('does not look up a payment when the payload names no order', async () => {
    const store = storeFor({ match: MATCHED });
    const outcome = await ingestProviderWebhook(
      Buffer.from(JSON.stringify({ event: 'order_paid' }), 'utf8'),
      {},
      dependenciesFor(store),
    );

    expect(outcome.kind).toBe('unmatched');
    expect(store.calls.lookups).toEqual([]);
  });
});

describe('duplicate delivery', () => {
  it('is a no-op the second time', async () => {
    // At-least-once is the norm. The database decides this, not memory, so it
    // holds across restarts and across processes.
    const store = storeFor({ match: MATCHED, duplicate: true });
    const outcome = await ingestProviderWebhook(
      bodyFor('order_paid_by_pix', 3531),
      {},
      dependenciesFor(store),
    );

    expect(outcome).toEqual({ kind: 'duplicate' });
    expect(store.calls.broughtForward).toEqual([]);
  });

  it('identifies a delivery by its bytes when the provider sends no id', async () => {
    // A provider that sends no delivery id still has to dedupe, so identity comes
    // from the bytes: a redelivery hashes the same and a different one does not.
    const first = storeFor({ match: MATCHED });
    const second = storeFor({ match: MATCHED });
    const third = storeFor({ match: MATCHED });

    await ingestProviderWebhook(bodyFor('order_paid', 3531), {}, dependenciesFor(first));
    await ingestProviderWebhook(bodyFor('order_paid', 3531), {}, dependenciesFor(second));
    await ingestProviderWebhook(bodyFor('order_paid', 4242), {}, dependenciesFor(third));

    expect(second.calls.events[0]?.providerEventId).toBe(first.calls.events[0]?.providerEventId);
    expect(third.calls.events[0]?.providerEventId).not.toBe(first.calls.events[0]?.providerEventId);
  });

  it('prefers the provider’s own delivery id when there is one', async () => {
    const store = storeFor({ match: MATCHED });
    await ingestProviderWebhook(
      Buffer.from(JSON.stringify({ id: 'evt_9', event: 'order_paid', data: { id: 1 } }), 'utf8'),
      {},
      dependenciesFor(store),
    );

    expect(store.calls.events[0]?.providerEventId).toBe('evt_9');
  });
});

describe('a notification that is not one', () => {
  it.each([
    ['not json at all', Buffer.from('<html>nope</html>', 'utf8')],
    ['json that is not an object', Buffer.from('"a string"', 'utf8')],
    ['an object naming no event', Buffer.from('{"data":{"id":1}}', 'utf8')],
    ['an empty body', Buffer.from('', 'utf8')],
  ])('refuses %s without recording or acting', async (_label, body) => {
    const store = storeFor({ match: MATCHED });
    const outcome = await ingestProviderWebhook(body, {}, dependenciesFor(store));

    expect(outcome.kind).toBe('unreadable');
    expect(store.calls.events).toEqual([]);
    expect(store.calls.broughtForward).toEqual([]);
  });
});

describe('authentication happens before anything is read', () => {
  it('refuses a notification the receiver will not authenticate', async () => {
    // It must refuse before the body is parsed: a signature covers what was sent,
    // not what a parser reconstructed. Parsing here fails the test outright.
    const store = storeFor({ match: MATCHED });
    const refusing: ProviderWebhookReceiver = {
      providerCode: 'test-provider',
      signsNotifications: true,
      verify: () => false,
      parse: () => {
        throw new Error('parsed before the signature was checked');
      },
    };

    const outcome = await ingestProviderWebhook(
      bodyFor('order_paid_by_pix', 3531),
      {},
      dependenciesFor(store, refusing),
    );

    expect(outcome.kind).toBe('unreadable');
    expect(store.calls.events).toEqual([]);
  });

  it('hands the receiver the bytes as received', async () => {
    const body = bodyFor('order_paid', 3531);
    let seen: Buffer | undefined;
    const receiver: ProviderWebhookReceiver = {
      providerCode: 'test-provider',
      signsNotifications: true,
      verify: (rawBody) => {
        seen = rawBody;
        return true;
      },
      parse: () => ({ kind: 'unreadable', reason: 'not needed here' }),
    };

    await ingestProviderWebhook(body, {}, dependenciesFor(storeFor({}), receiver));

    expect(seen?.equals(body)).toBe(true);
  });
});
