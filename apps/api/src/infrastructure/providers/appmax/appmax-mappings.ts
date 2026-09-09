import type { ObservedLifecycle } from '../../../application/ports/payment-provider.js';

/**
 * Everything Appmax-specific about vocabulary lives here.
 *
 * Two translations, both total and both explicit: the order statuses Appmax
 * reports, and the webhook events it emits. Nothing above this file knows either
 * set of words.
 *
 * Unrecognised input maps to `unknown` rather than to something convenient. The
 * legacy system defaulted an unfamiliar status to "pending", which turned every
 * status Appmax added afterwards into a payment that waited forever.
 */

/**
 * The order statuses documented by Appmax, in Portuguese as they arrive.
 */
export const APPMAX_ORDER_STATUSES = [
  'pendente',
  'aprovado',
  'autorizado',
  'cancelado',
  'estornado',
  'recusado_por_risco',
  'integrado',
  'pendente_integracao',
  'pendente_integracao_em_analise',
  'chargeback_em_tratativa',
  'chargeback_em_disputa',
  'chargeback_perdido',
  'chargeback_vencido',
] as const;

export type AppmaxOrderStatus = (typeof APPMAX_ORDER_STATUSES)[number];

const ORDER_STATUS_TO_LIFECYCLE: Readonly<Record<AppmaxOrderStatus, ObservedLifecycle>> = {
  // Created, no money yet.
  pendente: 'awaiting_payment',

  // Money received. `integrado` is Appmax's final approved state, reached after
  // its own downstream integrations have run; both mean the customer paid.
  aprovado: 'paid',
  integrado: 'paid',

  // Paid, with Appmax's integration still catching up. Funds are held either way,
  // so from the gateway's point of view this is paid.
  pendente_integracao: 'paid',
  pendente_integracao_em_analise: 'paid',

  // A card authorization is not money in hand. Treated as still awaiting, because
  // Pix never produces it and a card provider would capture separately.
  autorizado: 'awaiting_payment',

  // An expired Pix QR arrives here, as does an unauthorized card. Appmax does not
  // distinguish the two, so neither does this: both mean no money and no
  // instrument, which the gateway records as expired rather than guessing at a
  // failure reason it cannot know.
  cancelado: 'expired',

  estornado: 'refunded',
  recusado_por_risco: 'failed',

  chargeback_em_tratativa: 'chargeback',
  chargeback_em_disputa: 'chargeback',
  chargeback_perdido: 'chargeback',

  // Documented as "disputa de chargeback vencida", which reads either as the
  // dispute having been won or as it having lapsed. The two have opposite
  // meanings for the merchant's money, so this stays `chargeback` and is resolved
  // by an operator rather than by a guess. Confirming it is on the sandbox
  // validation list.
  chargeback_vencido: 'chargeback',
};

export function isAppmaxOrderStatus(candidate: unknown): candidate is AppmaxOrderStatus {
  return (
    typeof candidate === 'string' && APPMAX_ORDER_STATUSES.includes(candidate as AppmaxOrderStatus)
  );
}

export function lifecycleForOrderStatus(status: unknown): ObservedLifecycle {
  if (!isAppmaxOrderStatus(status)) {
    return 'unknown';
  }
  return ORDER_STATUS_TO_LIFECYCLE[status];
}

/**
 * The webhook events relevant to a Pix payment.
 *
 * None of these funds a payment on its own. Appmax sends no signature of any
 * kind, so an event is a prompt to read authoritative state, and the read decides.
 * What the mapping gives us is the ability to ignore events that cannot possibly
 * change anything, rather than reading on every delivery.
 */
export const APPMAX_PIX_WEBHOOK_EVENTS = [
  'order_pix_created',
  'order_paid_by_pix',
  'order_pix_expired',
  'order_approved',
  'order_paid',
  'order_integrated',
  'order_refund',
  'order_partial_refund',
  'order_chargeback_in_treatment',
  'order_charge_back_gain',
  'order_refused_by_risk',
] as const;

type AppmaxPixWebhookEvent = (typeof APPMAX_PIX_WEBHOOK_EVENTS)[number];

/**
 * Whether an event could plausibly change what we believe, and so warrants a read.
 */
const EVENT_WARRANTS_READ: Readonly<Record<AppmaxPixWebhookEvent, boolean>> = {
  // Tells us an instrument exists, which we already knew from the create call.
  order_pix_created: false,

  order_paid_by_pix: true,
  order_approved: true,
  order_paid: true,
  order_integrated: true,
  order_pix_expired: true,
  order_refund: true,
  order_partial_refund: true,
  order_chargeback_in_treatment: true,
  order_charge_back_gain: true,
  order_refused_by_risk: true,
};

function isAppmaxPixWebhookEvent(candidate: unknown): candidate is AppmaxPixWebhookEvent {
  return (
    typeof candidate === 'string' &&
    APPMAX_PIX_WEBHOOK_EVENTS.includes(candidate as AppmaxPixWebhookEvent)
  );
}

/**
 * An unrecognised event still warrants a read.
 *
 * Appmax documents forty events and may add more. Ignoring one we have not seen
 * before risks missing a payment; reading on it costs one API call.
 */
export function requiresProviderRead(event: unknown): boolean {
  if (!isAppmaxPixWebhookEvent(event)) {
    return true;
  }
  return EVENT_WARRANTS_READ[event];
}
