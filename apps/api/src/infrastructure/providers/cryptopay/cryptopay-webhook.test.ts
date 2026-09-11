import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Secret } from '@gateway/shared/server';
import { CryptoPayWebhookReceiver } from './cryptopay-webhook.js';

/**
 * Signed exactly as Standard Webhooks specifies and as CryptoPay signs, written
 * out here rather than imported so the receiver is checked against the
 * specification and not against its own understanding of it.
 */
function sign(secret: string, identifier: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const digest = createHmac('sha256', key)
    .update(`${identifier}.${timestamp.toString()}.${body}`)
    .digest('base64');
  return `v1,${digest}`;
}

const SECRET = `whsec_${randomBytes(32).toString('base64')}`;
const OTHER_SECRET = `whsec_${randomBytes(32).toString('base64')}`;
const NOW = 1_800_000_000;

const ENVELOPE = {
  identifier: 'whd_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
  type: 'payment.completed',
  occurredAt: '2026-09-11T00:10:00.000Z',
  environment: 'test',
  data: { identifier: 'pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N', status: 'completed' },
};

function headersFor(
  body: string,
  options: { secret?: string; timestamp?: number; identifier?: string } = {},
): Record<string, string> {
  const identifier = options.identifier ?? ENVELOPE.identifier;
  const timestamp = options.timestamp ?? NOW;
  return {
    'webhook-id': identifier,
    'webhook-timestamp': timestamp.toString(),
    'webhook-signature': sign(options.secret ?? SECRET, identifier, timestamp, body),
    'content-type': 'application/json',
  };
}

function receiver(secrets: readonly string[] = [SECRET]): CryptoPayWebhookReceiver {
  return new CryptoPayWebhookReceiver(
    secrets.map((secret) => new Secret(secret)),
    { now: () => NOW },
  );
}

describe('verifying a CryptoPay notification', () => {
  it('accepts a signature over the raw bytes', () => {
    const body = JSON.stringify(ENVELOPE);
    expect(receiver().verify(Buffer.from(body), headersFor(body))).toBe(true);
  });

  it('rejects a signature made with another secret', () => {
    const body = JSON.stringify(ENVELOPE);
    expect(receiver().verify(Buffer.from(body), headersFor(body, { secret: OTHER_SECRET }))).toBe(
      false,
    );
  });

  it('accepts either secret during a rotation', () => {
    const body = JSON.stringify(ENVELOPE);
    const both = receiver([OTHER_SECRET, SECRET]);
    expect(both.verify(Buffer.from(body), headersFor(body))).toBe(true);
    expect(both.verify(Buffer.from(body), headersFor(body, { secret: OTHER_SECRET }))).toBe(true);
  });

  it('rejects a body that differs from what was signed, even by whitespace', () => {
    const body = JSON.stringify(ENVELOPE);
    const headers = headersFor(body);
    const reformatted = Buffer.from(JSON.stringify(ENVELOPE, null, 2));
    expect(receiver().verify(reformatted, headers)).toBe(false);
  });

  it('rejects a signature replayed under another event id', () => {
    const body = JSON.stringify(ENVELOPE);
    const headers = { ...headersFor(body), 'webhook-id': 'whd_other' };
    expect(receiver().verify(Buffer.from(body), headers)).toBe(false);
  });

  it('rejects a timestamp outside the tolerance in either direction', () => {
    const body = JSON.stringify(ENVELOPE);
    expect(receiver().verify(Buffer.from(body), headersFor(body, { timestamp: NOW - 301 }))).toBe(
      false,
    );
    expect(receiver().verify(Buffer.from(body), headersFor(body, { timestamp: NOW + 301 }))).toBe(
      false,
    );
    expect(receiver().verify(Buffer.from(body), headersFor(body, { timestamp: NOW - 299 }))).toBe(
      true,
    );
  });

  it('rejects missing or malformed signature headers', () => {
    const body = JSON.stringify(ENVELOPE);
    const good = headersFor(body);
    expect(receiver().verify(Buffer.from(body), { ...good, 'webhook-signature': '' })).toBe(false);
    expect(receiver().verify(Buffer.from(body), { ...good, 'webhook-signature': 'v2,abc' })).toBe(
      false,
    );
    expect(receiver().verify(Buffer.from(body), { ...good, 'webhook-timestamp': 'soon' })).toBe(
      false,
    );
    expect(receiver().verify(Buffer.from(body), { ...good, 'webhook-id': undefined })).toBe(false);
  });

  it('verifies nothing when no secret is configured', () => {
    const body = JSON.stringify(ENVELOPE);
    expect(receiver([]).verify(Buffer.from(body), headersFor(body))).toBe(false);
  });
});

describe('parsing a CryptoPay notification', () => {
  it('takes the event id and the payment reference from the envelope', () => {
    const parsed = receiver().parse(Buffer.from(JSON.stringify(ENVELOPE)));
    expect(parsed).toEqual({
      kind: 'parsed',
      event: {
        eventId: 'whd_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
        eventType: 'payment.completed',
        providerReference: 'pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
        requiresRead: true,
      },
    });
  });

  it.each([
    ['payment.completed', true],
    ['payment.overpaid', true],
    ['payment.underpaid', true],
    ['payment.expired', true],
    ['payment.canceled', true],
    ['payment.confirming', false],
    ['payment.partially_funded', false],
  ])('%s requires a read: %s', (type, requiresRead) => {
    const parsed = receiver().parse(Buffer.from(JSON.stringify({ ...ENVELOPE, type })));
    expect(parsed.kind === 'parsed' && parsed.event.requiresRead).toBe(requiresRead);
  });

  it('refuses what is not a payment event envelope', () => {
    for (const body of [
      'not json',
      '[]',
      '{}',
      JSON.stringify({ ...ENVELOPE, type: 'settlement.x' }),
    ]) {
      expect(receiver().parse(Buffer.from(body)).kind).toBe('unreadable');
    }
  });

  it('parses an envelope naming no payment as matching nothing', () => {
    const parsed = receiver().parse(Buffer.from(JSON.stringify({ ...ENVELOPE, data: {} })));
    expect(parsed.kind === 'parsed' && parsed.event.providerReference).toBeUndefined();
  });
});
