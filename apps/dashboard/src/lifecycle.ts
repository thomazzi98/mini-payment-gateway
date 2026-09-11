import type { PaymentDetail } from './gateway-client';

/**
 * What a gateway record says about where a payment is, read for a screen.
 *
 * Every state here is derived from the record: the attempt the gateway opened,
 * the reference it stored, the provider notifications it verified, the
 * transition that funded the payment and the evidence it demanded, and what
 * became of the paid event. No timer advances anything. A screen re-reads the
 * record and re-derives; it never decides a step happened.
 */

// `handed` is the honest end of what this page can see: the gateway knows the
// platform accepted the notification, and nothing about what WAHA did with it.
type StageTone = 'waiting' | 'active' | 'done' | 'failed' | 'skipped' | 'handed';

export interface Stage {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly tone: StageTone;
}

type Phase =
  | 'created'
  | 'awaiting_payment'
  | 'detected'
  | 'confirmed'
  | 'paid'
  | 'notified'
  | 'uncertain'
  | 'expired'
  | 'failed';

interface TimelineEntry {
  readonly key: string;
  readonly at: string;
  readonly station: string;
  readonly text: string;
  readonly tone: StageTone;
}

export interface Lifecycle {
  readonly phase: Phase;
  readonly headline: string;
  readonly caption: string;
  readonly stages: readonly Stage[];
  readonly timeline: readonly TimelineEntry[];
  /**
  False once nothing about the record can still change.
  */
  readonly isSettling: boolean;
}

const terminal = new Set(['paid', 'failed', 'expired', 'cancelled']);
const closedDeliveries = new Set(['delivered', 'skipped', 'abandoned']);

const hasNotification = (detail: PaymentDetail, disposition: string): boolean =>
  detail.providerNotifications.some((notification) => notification.disposition === disposition);

function phaseOf(detail: PaymentDetail): Phase {
  const event = detail.events[0];
  if (detail.status === 'paid') {
    return event !== undefined && closedDeliveries.has(event.delivery.status) ? 'notified' : 'paid';
  }
  if (detail.status === 'expired') {
    return 'expired';
  }
  if (detail.status === 'failed' || detail.status === 'cancelled') {
    return 'failed';
  }
  if (detail.status === 'unknown') {
    return 'uncertain';
  }
  if (hasNotification(detail, 'scheduled_read')) {
    return 'confirmed';
  }
  if (detail.providerNotifications.length > 0) {
    return 'detected';
  }
  return detail.status === 'awaiting_payment' ? 'awaiting_payment' : 'created';
}

const headlines: Readonly<Record<Phase, { readonly headline: string; readonly caption: string }>> =
  {
    created: {
      headline: 'Creating',
      caption: 'The gateway is asking a provider for a destination.',
    },
    awaiting_payment: {
      headline: 'Waiting for payment',
      caption: 'Pay the destination below. The provider is scanning the chain for it.',
    },
    detected: {
      headline: 'Payment detected',
      caption: 'The provider saw the transfer and is holding it to its confirmation count.',
    },
    confirmed: {
      headline: 'Confirming',
      caption:
        'The provider signed off. The gateway is reading the payment back before believing it.',
    },
    paid: {
      headline: 'Paid',
      caption:
        'Funded on an authenticated read. Handing the paid event to the notification platform.',
    },
    notified: {
      headline: 'Paid',
      caption: 'Funded on an authenticated read, and the paid event has been handed on.',
    },
    uncertain: {
      headline: 'Uncertain',
      caption: 'The provider gave no usable answer. Reconciliation is asking again.',
    },
    expired: {
      headline: 'Expired',
      caption: 'Nobody paid the destination before it lapsed.',
    },
    failed: {
      headline: 'Not paid',
      caption: 'The payment could not be completed.',
    },
  };

const isAtLeast = (phases: readonly Phase[], phase: Phase): boolean => phases.includes(phase);

const advanced: readonly Phase[] = ['detected', 'confirmed', 'paid', 'notified'];
const funded: readonly Phase[] = ['paid', 'notified'];

function deliveryTone(detail: PaymentDetail): StageTone {
  const event = detail.events[0];
  if (event === undefined) {
    return 'waiting';
  }
  const tones: Readonly<Record<string, StageTone>> = {
    delivered: 'done',
    skipped: 'skipped',
    abandoned: 'failed',
  };
  return tones[event.delivery.status] ?? 'active';
}

function stagesOf(detail: PaymentDetail, phase: Phase): Stage[] {
  const isFailed = phase === 'failed' || phase === 'expired';
  const hasInstrument = detail.instrument !== undefined;
  const gatewayTone = (): StageTone => {
    if (isAtLeast(funded, phase)) {
      return 'done';
    }
    if (isFailed) {
      return 'failed';
    }
    return phase === 'uncertain' ? 'active' : 'done';
  };
  const providerTone = (): StageTone => {
    if (isAtLeast(advanced, phase)) {
      return 'done';
    }
    if (isFailed) {
      return 'failed';
    }
    return hasInstrument ? 'done' : 'active';
  };
  const chainTone = (): StageTone => {
    if (isAtLeast(advanced, phase)) {
      return 'done';
    }
    if (isFailed) {
      return 'failed';
    }
    return hasInstrument ? 'active' : 'waiting';
  };
  const confirmTone = (): StageTone => {
    if (isAtLeast(['confirmed', 'paid', 'notified'], phase)) {
      return 'done';
    }
    return phase === 'detected' ? 'active' : 'waiting';
  };
  const readTone = (): StageTone => {
    if (isAtLeast(funded, phase)) {
      return 'done';
    }
    return phase === 'confirmed' ? 'active' : 'waiting';
  };
  const eventTone = (): StageTone => (isAtLeast(funded, phase) ? 'done' : 'waiting');
  const delivery = isAtLeast(funded, phase) ? deliveryTone(detail) : 'waiting';
  const provider = detail.provider ?? 'provider';

  return [
    { id: 'browser', label: 'Browser', detail: 'POST /v1/payments', tone: 'done' },
    {
      id: 'gateway',
      label: 'Payment gateway',
      detail: 'claims the key, opens an attempt',
      tone: gatewayTone(),
    },
    {
      id: 'provider',
      label: provider,
      detail: hasInstrument ? 'issued the destination' : 'asked for a destination',
      tone: providerTone(),
    },
    {
      id: 'chain',
      label: 'Blockchain',
      detail: isAtLeast(advanced, phase) ? 'transfer seen' : 'waiting for a transfer',
      tone: chainTone(),
    },
    {
      id: 'provider-confirms',
      label: `${provider} confirms`,
      detail: 'signed webhook to the gateway',
      tone: confirmTone(),
    },
    {
      id: 'gateway-reads',
      label: 'Gateway verifies',
      detail: 'authenticated read decides',
      tone: readTone(),
    },
    {
      id: 'event',
      label: 'payment.paid',
      detail: 'same transaction as the money',
      tone: eventTone(),
    },
    {
      id: 'whatsapp',
      label: 'WhatsApp notification',
      detail: 'accepted with the event id as idempotency key',
      tone: delivery,
    },
    {
      id: 'waha',
      label: 'WAHA',
      detail:
        delivery === 'done' ? "the platform's to send; not observed here" : 'after the platform',
      tone: delivery === 'done' ? 'handed' : 'waiting',
    },
  ];
}

const humanise = (text: string): string => text.replaceAll('_', ' ');

function transitionEntry(
  detail: PaymentDetail,
  transition: PaymentDetail['transitions'][number],
): TimelineEntry {
  const provider = detail.provider ?? 'the provider';
  const texts: Readonly<Record<string, { readonly text: string; readonly tone: StageTone }>> = {
    processing: {
      text: `Attempt opened against ${provider}; creation request sent.`,
      tone: 'active',
    },
    awaiting_payment: {
      text: `${provider} answered with a destination${detail.providerReference === undefined ? '' : ` (${detail.providerReference})`}.`,
      tone: 'done',
    },
    paid: {
      text: `Paid on ${humanise(transition.evidenceClass)} — ${transition.trigger}. ${transition.reason ?? ''}`.trim(),
      tone: 'done',
    },
    unknown: {
      text: 'The provider outcome could not be determined; reconciliation owns it now.',
      tone: 'active',
    },
    expired: { text: `Expired — ${transition.trigger}.`, tone: 'failed' },
    failed: {
      text: `Failed — ${transition.trigger}. ${transition.reason ?? ''}`.trim(),
      tone: 'failed',
    },
    cancelled: { text: `Cancelled — ${transition.trigger}.`, tone: 'failed' },
  };
  const reading = texts[transition.toStatus] ?? {
    text: `${humanise(transition.fromStatus)} → ${humanise(transition.toStatus)} (${transition.trigger}).`,
    tone: 'active' as const,
  };
  return {
    key: `transition-${String(transition.sequence)}`,
    at: transition.occurredAt,
    station: 'gateway',
    text: reading.text,
    tone: reading.tone,
  };
}

function notificationEntry(
  notification: PaymentDetail['providerNotifications'][number],
  index: number,
): TimelineEntry {
  const isScheduled = notification.disposition === 'scheduled_read';
  return {
    key: `notification-${String(index)}`,
    at: notification.receivedAt,
    station: notification.provider,
    text: isScheduled
      ? `Signed ${notification.eventType} verified; an authenticated read was scheduled.`
      : `Signed ${notification.eventType} verified and recorded; nothing to read yet.`,
    tone: isScheduled ? 'done' : 'active',
  };
}

function eventEntries(detail: PaymentDetail): TimelineEntry[] {
  const fundedAt = detail.transitions.find((transition) => transition.toStatus === 'paid');
  return detail.events.flatMap((event, index) => {
    const written: TimelineEntry = {
      key: `event-${String(index)}`,
      at: fundedAt?.occurredAt ?? event.occurredAt,
      station: 'gateway',
      text: `${event.type} written in the same transaction as the money.`,
      tone: 'done',
    };
    const { delivery } = event;
    if (delivery.publishedAt === undefined) {
      return [written];
    }
    const outcomes: Readonly<Record<string, { readonly text: string; readonly tone: StageTone }>> =
      {
        delivered: {
          text: `Notification accepted${delivery.reference === undefined ? '' : ` (${delivery.reference})`} after ${String(delivery.attempts)} attempt(s). Sending through WAHA is the platform's.`,
          tone: 'done',
        },
        skipped: {
          text: 'Nobody to notify: the payment carried no phone number.',
          tone: 'skipped',
        },
        abandoned: {
          text: `Delivery abandoned: ${delivery.lastFailure ?? 'no reason recorded'}.`,
          tone: 'failed',
        },
      };
    const reading = outcomes[delivery.status] ?? {
      text: `Delivery ${delivery.status}.`,
      tone: 'active' as const,
    };
    return [
      written,
      {
        key: `delivery-${String(index)}`,
        at: delivery.publishedAt,
        station: 'whatsapp',
        text: reading.text,
        tone: reading.tone,
      },
    ];
  });
}

export function readLifecycle(detail: PaymentDetail): Lifecycle {
  const phase = phaseOf(detail);
  const event = detail.events[0];
  const timeline = [
    ...detail.transitions.map((transition) => transitionEntry(detail, transition)),
    ...detail.providerNotifications.map((notification, index) =>
      notificationEntry(notification, index),
    ),
    ...eventEntries(detail),
  ].toSorted((first, second) => Date.parse(first.at) - Date.parse(second.at));

  const isPendingDelivery =
    detail.status === 'paid' &&
    (event === undefined || !closedDeliveries.has(event.delivery.status));

  return {
    phase,
    ...headlines[phase],
    stages: stagesOf(detail, phase),
    timeline,
    isSettling: !terminal.has(detail.status) || isPendingDelivery,
  };
}

/**
 * Whether a paid payment's event failed to reach the platform, which the
 * screen must say plainly rather than fold into "paid".
 */
export function deliveryProblem(detail: PaymentDetail): string | undefined {
  const event = detail.events[0];
  if (event === undefined || event.delivery.status !== 'abandoned') {
    return undefined;
  }
  return `The paid event could not be handed to the notification platform: ${event.delivery.lastFailure ?? 'no reason recorded'}.`;
}
