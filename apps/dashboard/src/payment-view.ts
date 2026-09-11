import { formatAmount } from './amounts';
import { element, formatMoment, formatSince, replaceChildren, text } from './dom';
import type { PaymentDetail } from './gateway-client';
import { deliveryProblem, readLifecycle, type Lifecycle, type Stage } from './lifecycle';
import { browserWallet, parseTransferUri } from './wallet';

/**
 * The right-hand side of the screen: one payment, as the gateway records it.
 *
 * Rebuilt from the record on every read. There are no inputs here, so
 * replacing the children costs nothing a visitor would notice, and there is no
 * state of its own to drift from the gateway's.
 */

export interface PaymentViewHandlers {
  readonly onCopy: (value: string) => Promise<void>;
  readonly onPayWithWallet: (uri: string) => Promise<void>;
  readonly onNewPayment: () => void;
}

const marks: Readonly<Record<Stage['tone'], string>> = {
  waiting: '○',
  active: '●',
  done: '✓',
  failed: '✕',
  skipped: '–',
  handed: '›',
};

const phaseTone = (lifecycle: Lifecycle): string => {
  if (lifecycle.phase === 'paid' || lifecycle.phase === 'notified') {
    return 'done';
  }
  if (lifecycle.phase === 'expired' || lifecycle.phase === 'failed') {
    return 'failed';
  }
  return lifecycle.phase === 'uncertain' ? 'uncertain' : 'active';
};

const chainLabel = (uri: string | undefined): string | undefined => {
  const transfer = uri === undefined ? undefined : parseTransferUri(uri);
  return transfer === undefined ? undefined : `chain ${String(transfer.chainId)}`;
};

function fact(label: string, value: string | Node, options: { mono?: boolean } = {}): HTMLElement {
  return element('div', { class: 'fact' }, [
    element('dt', {}, [label]),
    element('dd', { class: options.mono === true ? 'mono' : undefined }, [value]),
  ]);
}

// Once nothing is left to pay, the destination is shown for the record and
// nothing on it asks for money.
const isPayable = (lifecycle: Lifecycle): boolean =>
  lifecycle.phase === 'awaiting_payment' || lifecycle.phase === 'created';

function instrumentBlock(
  detail: PaymentDetail,
  lifecycle: Lifecycle,
  handlers: PaymentViewHandlers,
  note: HTMLElement,
): HTMLElement | undefined {
  const { instrument } = detail;
  if (instrument === undefined) {
    return undefined;
  }
  if (instrument.type === 'pix') {
    return element('section', { class: 'instrument', 'aria-label': 'Pix code' }, [
      instrument.qrCodeImageDataUri === undefined
        ? undefined
        : element('img', {
            class: 'qr',
            src: instrument.qrCodeImageDataUri,
            alt: 'Pix QR code',
            width: '224',
            height: '224',
          }),
      element('div', { class: 'instrument__facts' }, [
        element('p', { class: 'mono breakable' }, [instrument.copyAndPasteCode]),
        element('div', { class: 'actions' }, [
          copyButton(instrument.copyAndPasteCode, 'Copy Pix code', handlers),
        ]),
      ]),
    ]);
  }

  const canPay = isPayable(lifecycle);
  const wallet = browserWallet();
  const walletButton = element('button', { type: 'button', class: 'button' }, [
    'Pay with browser wallet',
  ]);
  walletButton.addEventListener('click', () => {
    walletButton.disabled = true;
    void handlers.onPayWithWallet(instrument.paymentUri).finally(() => {
      walletButton.disabled = false;
    });
  });

  return element('section', { class: 'instrument', 'aria-label': 'Payment destination' }, [
    element('img', {
      class: canPay ? 'qr' : 'qr qr--settled',
      src: instrument.qrCodeImageDataUri,
      alt: `QR code paying ${formatAmount(detail.amountMinor, detail.currency)} to ${instrument.destinationAddress}`,
      width: '224',
      height: '224',
    }),
    element('div', { class: 'instrument__facts' }, [
      element('p', { class: 'instrument__amount' }, [
        formatAmount(detail.amountMinor, detail.currency),
      ]),
      element('p', { class: 'instrument__network' }, [
        [instrument.network, chainLabel(instrument.paymentUri)].filter(Boolean).join(' · '),
      ]),
      element('dl', { class: 'facts' }, [
        fact('Destination', instrument.destinationAddress, { mono: true }),
        fact('Payment URI', instrument.paymentUri, { mono: true }),
        instrument.expiresAt === undefined
          ? undefined
          : fact('Expires', formatMoment(instrument.expiresAt)),
      ]),
      canPay &&
        element('div', { class: 'actions' }, [
          element('a', { class: 'button', href: instrument.paymentUri }, ['Open in a wallet']),
          copyButton(instrument.paymentUri, 'Copy URI', handlers),
          copyButton(instrument.destinationAddress, 'Copy address', handlers),
          wallet === undefined ? undefined : walletButton,
        ]),
      canPay && note,
      canPay &&
        element('p', { class: 'hint' }, [
          'This page never touches the chain. Pay from a wallet connected to it, or run ',
          element('code', {}, ['npm run demo:pay -- <payment URI>']),
          ' in the gateway repository to pay as the customer.',
        ]),
    ]),
  ]);
}

function copyButton(value: string, label: string, handlers: PaymentViewHandlers): HTMLElement {
  const button = element('button', { type: 'button', class: 'button button--quiet' }, [label]);
  button.addEventListener('click', () => {
    void handlers.onCopy(value).then(() => {
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = label;
      }, 1500);
    });
  });
  return button;
}

function stagesList(lifecycle: Lifecycle): HTMLElement {
  return element(
    'ol',
    { class: 'stages', 'aria-label': 'Where the payment is' },
    lifecycle.stages.map((stage) =>
      element('li', { class: 'stage', 'data-tone': stage.tone }, [
        element('span', { class: 'stage__mark', 'aria-hidden': 'true' }, [marks[stage.tone]]),
        element('span', { class: 'sr-only' }, [`${stage.tone}: `]),
        element('span', { class: 'stage__label' }, [stage.label]),
        element('span', { class: 'stage__detail' }, [stage.detail]),
      ]),
    ),
  );
}

function timelineList(detail: PaymentDetail, lifecycle: Lifecycle): HTMLElement {
  if (lifecycle.timeline.length === 0) {
    return element('p', { class: 'hint' }, ['Nothing recorded yet.']);
  }
  return element(
    'ol',
    { class: 'timeline', 'aria-label': 'What the gateway recorded' },
    lifecycle.timeline.map((entry) =>
      element('li', { class: 'timeline__entry', 'data-tone': entry.tone }, [
        element('span', { class: 'timeline__at mono' }, [formatSince(detail.createdAt, entry.at)]),
        element('span', { class: 'timeline__station mono' }, [entry.station]),
        element('span', { class: 'timeline__text' }, [entry.text]),
      ]),
    ),
  );
}

export function renderEmpty(target: Element): void {
  replaceChildren(target, [
    element('div', { class: 'empty' }, [
      element('p', { class: 'empty__title' }, ['No payment yet']),
      element('p', { class: 'hint' }, [
        'Create one on the left. Every state shown here is read back from the gateway; nothing on this page advances on its own.',
      ]),
    ]),
  ]);
}

export function renderPayment(
  target: Element,
  detail: PaymentDetail,
  handlers: PaymentViewHandlers,
  walletNote: string | undefined,
): void {
  const lifecycle = readLifecycle(detail);
  const problem = deliveryProblem(detail);
  const note = element('p', { class: 'hint', 'aria-live': 'polite' }, [walletNote ?? '']);
  const newPayment = element('button', { type: 'button', class: 'button button--quiet' }, [
    'New payment',
  ]);
  newPayment.addEventListener('click', handlers.onNewPayment);

  replaceChildren(target, [
    element('header', { class: 'status', 'data-tone': phaseTone(lifecycle) }, [
      element('p', { class: 'eyebrow' }, [
        `Payment ${detail.id} · ${detail.environment.toLowerCase()}`,
        lifecycle.isSettling ? ' · reading back every 2 s' : ' · settled',
      ]),
      element('h2', { class: 'status__headline', 'aria-live': 'polite' }, [lifecycle.headline]),
      element('p', { class: 'status__caption' }, [lifecycle.caption]),
      problem === undefined
        ? undefined
        : element('p', { class: 'alert', role: 'alert' }, [problem]),
    ]),
    instrumentBlock(detail, lifecycle, handlers, note),
    element('section', { class: 'panel', 'aria-labelledby': 'flow-title' }, [
      element('h3', { id: 'flow-title', class: 'panel__title' }, ['The flow']),
      stagesList(lifecycle),
    ]),
    element('section', { class: 'panel', 'aria-labelledby': 'record-title' }, [
      element('h3', { id: 'record-title', class: 'panel__title' }, ['The record']),
      element('dl', { class: 'facts facts--grid' }, [
        fact('Status', text(detail.status.replaceAll('_', ' '))),
        fact('Method', detail.paymentMethod),
        fact('Requested', formatAmount(detail.amountMinor, detail.currency)),
        fact('Captured', formatAmount(detail.capturedAmountMinor, detail.currency)),
        fact('Provider', detail.provider ?? '—'),
        fact('Provider reference', detail.providerReference ?? '—', { mono: true }),
        fact('Merchant reference', detail.merchantReference, { mono: true }),
        fact('Created', formatMoment(detail.createdAt)),
        detail.paidAt === undefined ? undefined : fact('Paid at', formatMoment(detail.paidAt)),
      ]),
    ]),
    element('section', { class: 'panel', 'aria-labelledby': 'timeline-title' }, [
      element('h3', { id: 'timeline-title', class: 'panel__title' }, ['Timeline']),
      timelineList(detail, lifecycle),
    ]),
    element('div', { class: 'actions' }, [newPayment]),
  ]);
}
