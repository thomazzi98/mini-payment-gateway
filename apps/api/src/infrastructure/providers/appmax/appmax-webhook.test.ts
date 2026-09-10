import { describe, expect, it } from 'vitest';
import { AppmaxWebhookReceiver } from './appmax-webhook.js';

/**
 * The Appmax parser.
 *
 * These fixtures encode what the documentation implies, not what has been seen on
 * the wire: no real delivery has ever been received, because that needs a
 * developer account this project does not have. They are therefore the thing to
 * check a real delivery against, and the reason the parser refuses what it does
 * not recognise instead of guessing.
 */

const receiver = new AppmaxWebhookReceiver();

function body(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function parsed(payload: unknown) {
  const result = receiver.parse(body(payload));
  if (result.kind !== 'parsed') {
    throw new Error(`expected the notification to parse, got: ${result.reason}`);
  }
  return result.event;
}

describe('what Appmax is documented to send', () => {
  it('reads the event and the order it names', () => {
    const event = parsed({ event: 'order_paid_by_pix', data: { id: 3531 } });

    expect(event.eventType).toBe('order_paid_by_pix');
    expect(event.providerReference).toBe('3531');
  });

  it('reads a numeric order id as the same reference as a string one', () => {
    // JSON does not distinguish 3531 from "3531", and Appmax's own examples use
    // both. They name one order.
    expect(parsed({ event: 'order_paid', data: { id: 3531 } }).providerReference).toBe('3531');
    expect(parsed({ event: 'order_paid', data: { id: '3531' } }).providerReference).toBe('3531');
  });

  it('reads order_id, which the payment examples use instead of id', () => {
    expect(parsed({ event: 'order_paid', data: { order_id: 77 } }).providerReference).toBe('77');
  });

  it('asks for a read on every event that could change what we believe', () => {
    for (const eventType of [
      'order_paid_by_pix',
      'order_approved',
      'order_paid',
      'order_integrated',
      'order_pix_expired',
      'order_refused_by_risk',
    ]) {
      expect(parsed({ event: eventType, data: { id: 1 } }).requiresRead).toBe(true);
    }
  });

  it('does not ask for a read on an event that cannot change anything', () => {
    // The instrument existing is what the create call already established.
    expect(parsed({ event: 'order_pix_created', data: { id: 1 } }).requiresRead).toBe(false);
  });

  it('asks for a read on an event nobody has mapped', () => {
    // Appmax documents forty events and may add more. Ignoring an unfamiliar one
    // risks missing a payment; reading on it costs one call.
    expect(parsed({ event: 'order_something_new', data: { id: 1 } }).requiresRead).toBe(true);
  });
});

describe('identifying a delivery', () => {
  it('uses the provider’s own id when the payload carries one', () => {
    expect(parsed({ id: 'evt_17', event: 'order_paid', data: { id: 1 } }).eventId).toBe('evt_17');
  });

  it('derives a stable id from the bytes when it does not', () => {
    const first = parsed({ event: 'order_paid', data: { id: 3531 } });
    const again = parsed({ event: 'order_paid', data: { id: 3531 } });

    expect(again.eventId).toBe(first.eventId);
  });

  it('derives a different id for a different notification', () => {
    const paid = parsed({ event: 'order_paid', data: { id: 3531 } });
    const other = parsed({ event: 'order_paid', data: { id: 3532 } });

    expect(other.eventId).not.toBe(paid.eventId);
  });
});

describe('what Appmax does not send', () => {
  it.each([
    ['a body that is not JSON', Buffer.from('<html>nope</html>', 'utf8')],
    ['JSON that is not an object', Buffer.from('42', 'utf8')],
    ['an empty body', Buffer.from('', 'utf8')],
  ])('refuses %s', (_label, raw) => {
    expect(receiver.parse(raw).kind).toBe('unreadable');
  });

  it('refuses an object that names no event', () => {
    expect(receiver.parse(body({ data: { id: 1 } })).kind).toBe('unreadable');
  });

  it('parses an event that names no order, leaving it unmatched', () => {
    // Readable, but about nothing we hold. That is a matching problem rather than
    // a parsing one, and the two are answered differently.
    expect(parsed({ event: 'order_paid' }).providerReference).toBeUndefined();
  });
});

describe('signatures', () => {
  it('reports that Appmax signs nothing, rather than implying a check happened', () => {
    // Appmax documents that its webhooks carry no signature and no token. Saying
    // so is what lets the rest of the system treat a notification as a prompt
    // rather than as evidence.
    expect(receiver.signsNotifications).toBe(false);
  });
});
