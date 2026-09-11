import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from './amounts';
import type { PaymentDetail } from './gateway-client';
import { deliveryProblem, readLifecycle } from './lifecycle';
import paidFixture from './paid-payment.fixture.json';

// A payment the gateway recorded during the end-to-end run, read back through
// its own API; only the QR code is shortened. The screen shows what is derived
// from this record and nothing else.
const paid = paidFixture as PaymentDetail;

const withChanges = (
  detail: PaymentDetail,
  changes: { readonly [Key in keyof PaymentDetail]?: PaymentDetail[Key] | undefined },
): PaymentDetail => ({ ...detail, ...changes }) as PaymentDetail;

const awaiting = withChanges(paid, {
  status: 'awaiting_payment',
  capturedAmountMinor: '0',
  transitions: paid.transitions.slice(0, 2),
  providerNotifications: [],
  events: [],
});

const stageTone = (detail: PaymentDetail, id: string) =>
  readLifecycle(detail).stages.find((stage) => stage.id === id)?.tone;

describe('reading a paid and notified payment', () => {
  it('reports the final phase and lights every stage the gateway can see', () => {
    const lifecycle = readLifecycle(paid);
    expect(lifecycle.phase).toBe('notified');
    expect(lifecycle.headline).toBe('Paid');
    expect(lifecycle.isSettling).toBe(false);
    expect(lifecycle.stages.map((stage) => stage.tone)).toEqual([
      ...Array.from({ length: 8 }, () => 'done'),
      'handed',
    ]);
    expect(lifecycle.stages.map((stage) => stage.id)).toEqual([
      'browser',
      'gateway',
      'provider',
      'chain',
      'provider-confirms',
      'gateway-reads',
      'event',
      'whatsapp',
      'waha',
    ]);
  });

  it('prints the record as a timeline in the order it happened', () => {
    const { timeline } = readLifecycle(paid);
    expect(timeline.map((entry) => entry.station)).toEqual([
      'gateway',
      'gateway',
      'cryptopay',
      'cryptopay',
      'gateway',
      'gateway',
      'whatsapp',
    ]);
    const moments = timeline.map((entry) => Date.parse(entry.at));
    expect(moments).toEqual(moments.toSorted((first, second) => first - second));
    expect(timeline[4]?.text).toContain('authenticated provider read');
    expect(timeline[6]?.text).toContain('Notification accepted');
  });
});

describe('reading a payment on its way', () => {
  it('waits on the chain once the destination is issued', () => {
    const lifecycle = readLifecycle(awaiting);
    expect(lifecycle.phase).toBe('awaiting_payment');
    expect(lifecycle.isSettling).toBe(true);
    expect(stageTone(awaiting, 'provider')).toBe('done');
    expect(stageTone(awaiting, 'chain')).toBe('active');
    expect(stageTone(awaiting, 'provider-confirms')).toBe('waiting');
    expect(stageTone(awaiting, 'whatsapp')).toBe('waiting');
  });

  it('shows the transfer as detected on the first provider notification', () => {
    const detected = withChanges(awaiting, {
      providerNotifications: paid.providerNotifications.slice(0, 1),
    });
    const lifecycle = readLifecycle(detected);
    expect(lifecycle.phase).toBe('detected');
    expect(lifecycle.headline).toBe('Payment detected');
    expect(stageTone(detected, 'chain')).toBe('done');
    expect(stageTone(detected, 'provider-confirms')).toBe('active');
  });

  it('shows the gateway verifying once the provider has signed off', () => {
    const confirmed = withChanges(awaiting, {
      providerNotifications: paid.providerNotifications,
    });
    const lifecycle = readLifecycle(confirmed);
    expect(lifecycle.phase).toBe('confirmed');
    expect(stageTone(confirmed, 'provider-confirms')).toBe('done');
    expect(stageTone(confirmed, 'gateway-reads')).toBe('active');
    expect(stageTone(confirmed, 'event')).toBe('waiting');
  });

  it('keeps settling while the paid event is still being handed over', () => {
    const pending = withChanges(paid, {
      events: [
        {
          type: 'payment.paid',
          occurredAt: paid.paidAt ?? paid.createdAt,
          delivery: { channel: 'whatsapp', status: 'pending', attempts: 0 },
        },
      ],
    });
    const lifecycle = readLifecycle(pending);
    expect(lifecycle.phase).toBe('paid');
    expect(lifecycle.isSettling).toBe(true);
    expect(stageTone(pending, 'whatsapp')).toBe('active');
    expect(stageTone(pending, 'waha')).toBe('waiting');
  });
});

describe('reading a payment that did not go through', () => {
  it('reports an expired destination as failed stages', () => {
    const expired = withChanges(awaiting, { status: 'expired' });
    const lifecycle = readLifecycle(expired);
    expect(lifecycle.phase).toBe('expired');
    expect(lifecycle.isSettling).toBe(false);
    expect(stageTone(expired, 'chain')).toBe('failed');
  });

  it('reports an uncertain outcome without pretending anything else', () => {
    const uncertain = withChanges(awaiting, { status: 'unknown', providerReference: undefined });
    const lifecycle = readLifecycle(uncertain);
    expect(lifecycle.phase).toBe('uncertain');
    expect(lifecycle.isSettling).toBe(true);
    expect(stageTone(uncertain, 'gateway')).toBe('active');
  });

  it('names a delivery the platform refused instead of folding it into paid', () => {
    const abandoned = withChanges(paid, {
      events: paid.events.map((event) => ({
        ...event,
        delivery: {
          ...event.delivery,
          status: 'abandoned',
          lastFailure: 'The notification platform refused the message (422: recipient invalid).',
        },
      })),
    });
    expect(readLifecycle(abandoned).phase).toBe('notified');
    expect(stageTone(abandoned, 'whatsapp')).toBe('failed');
    expect(deliveryProblem(abandoned)).toContain('recipient invalid');
    expect(deliveryProblem(paid)).toBeUndefined();
  });
});

describe('amounts', () => {
  it('turns a decimal into minor units for the currency without a float', () => {
    expect(parseAmount('100', 'USDC')).toBe(100_000_000);
    expect(parseAmount('1.50', 'USDC')).toBe(1_500_000);
    expect(parseAmount('0.000001', 'USDC')).toBe(1);
    expect(parseAmount('19.99', 'BRL')).toBe(1999);
    expect(parseAmount('19.999', 'BRL')).toBeUndefined();
    expect(parseAmount('0', 'USDC')).toBeUndefined();
    expect(parseAmount('1,5', 'USDC')).toBeUndefined();
    expect(parseAmount('100', 'USDC')).toBe(100_000_000);
    expect(parseAmount('100.000001', 'USDC')).toBeUndefined();
    expect(parseAmount('1000000', 'BRL')).toBe(100_000_000);
    expect(parseAmount('1000000.01', 'BRL')).toBeUndefined();
  });

  it('formats minor units back in the currency', () => {
    expect(formatAmount('1500000', 'USDC')).toBe('1.500000 USDC');
    expect(formatAmount('1999', 'BRL')).toBe('19.99 BRL');
    expect(formatAmount('0', 'USDC')).toBe('0.000000 USDC');
  });
});
