import { CheckoutForm } from './checkout-form';
import { element, replaceChildren, requireElement } from './dom';
import {
  createPayment,
  readPayment,
  readPaymentOptions,
  readReadiness,
  type Connection,
  type CreatePaymentRequest,
  type GatewayFailure,
  type IntegrationStatus,
  type PaymentDetail,
  type Readiness,
} from './gateway-client';
import { readLifecycle } from './lifecycle';
import { renderEmpty, renderPayment } from './payment-view';
import { payWithWallet } from './wallet';
import './styles.css';

/**
 * The demo checkout: a merchant-side page that creates a payment through the
 * gateway and shows the customer what to pay, then reads the gateway back until
 * the record settles.
 *
 * The API key is the merchant's, kept in this browser only. Every other secret
 * stays where it belongs: the gateway holds the provider and platform keys, and
 * this page never sees them.
 */

const storageKeys = { url: 'gateway-demo.url', key: 'gateway-demo.api-key' } as const;
const pollMilliseconds = 2000;
const configuredGatewayUrl: unknown = import.meta.env.VITE_GATEWAY_URL;
const defaultGatewayUrl =
  typeof configuredGatewayUrl === 'string' && configuredGatewayUrl !== ''
    ? configuredGatewayUrl
    : 'http://127.0.0.1:4010';

const stored = (name: string): string | undefined => {
  try {
    return localStorage.getItem(name) ?? undefined;
  } catch {
    return undefined;
  }
};

const store = (name: string, value: string): void => {
  try {
    localStorage.setItem(name, value);
  } catch {
    // The page still works; the key is typed again next time.
  }
};

const integrationLabels: Readonly<Record<IntegrationStatus, string>> = {
  up: 'reachable',
  down: 'not answering',
  not_configured: 'not configured',
};

function reachBadge(label: string, status: IntegrationStatus | 'unknown'): HTMLElement {
  return element('span', { class: 'badge', 'data-status': status }, [
    `${label} · ${status === 'unknown' ? 'unknown' : integrationLabels[status]}`,
  ]);
}

function gatewayReach(
  readiness: Readiness | undefined,
  isChecked: boolean,
): IntegrationStatus | 'unknown' {
  if (!isChecked) {
    return 'unknown';
  }
  return readiness === undefined ? 'down' : 'up';
}

function describeFailure(failure: GatewayFailure, baseUrl: string): string {
  const byCode: Readonly<Record<string, string>> = {
    unreachable: `The gateway could not be reached at ${baseUrl}. Is it running, and is this page's origin allowed to call it?`,
    invalid_api_key: 'The gateway refused the API key.',
    missing_api_key: 'The gateway refused the API key.',
    insufficient_scope: 'This API key cannot do that: it needs payments:write and payments:read.',
    amount_exceeds_limit: 'That amount is above the limit configured for this account.',
    duplicate_merchant_reference: 'A live payment already exists for that reference. Try again.',
    idempotency_key_in_flight: 'The same request is still being processed. Try again shortly.',
    payment_not_found: 'The gateway no longer finds that payment.',
  };
  const known = byCode[failure.code];
  if (known !== undefined) {
    return known;
  }
  if (failure.status === 401) {
    return 'The gateway refused the API key.';
  }
  if (failure.status >= 500) {
    return 'The gateway could not complete the request. Try again.';
  }
  if (failure.code === 'invalid_request' && failure.param === 'amount') {
    return 'The gateway does not accept that amount.';
  }
  return failure.param === undefined ? failure.message : `${failure.message} (${failure.param})`;
}

class DemoCheckout {
  readonly #form: CheckoutForm;

  readonly #paymentTarget: HTMLElement;

  readonly #urlInput: HTMLInputElement;

  readonly #keyInput: HTMLInputElement;

  readonly #reach: HTMLElement;

  readonly #connectionNote: HTMLElement;

  #pollTimer: ReturnType<typeof setTimeout> | undefined;

  #walletNote: string | undefined;

  #current: PaymentDetail | undefined;

  public constructor(root: ParentNode) {
    this.#paymentTarget = requireElement(root, '[data-payment]', 'section');
    this.#urlInput = requireElement(root, '[data-gateway-url]', 'input');
    this.#keyInput = requireElement(root, '[data-api-key]', 'input');
    this.#reach = requireElement(root, '[data-reach]', 'div');
    this.#connectionNote = requireElement(root, '[data-connection-note]', 'p');
    this.#form = new CheckoutForm(requireElement(root, '[data-checkout]', 'form'), {
      onChange: () => {},
      onSubmit: (request) => {
        void this.#create(request);
      },
    });

    this.#urlInput.value = stored(storageKeys.url) ?? defaultGatewayUrl;
    this.#keyInput.value = stored(storageKeys.key) ?? '';
    // A first visit has nothing to connect with, so the panel that asks for it
    // is the first thing on the page; once a key is remembered it folds away.
    requireElement(root, '[data-connection]', 'details').open = this.#keyInput.value === '';
    requireElement(root, '[data-connect]', 'button').addEventListener('click', () => {
      void this.connect();
    });
    renderEmpty(this.#paymentTarget);
    this.#renderReach(undefined, false);
    if (this.#keyInput.value !== '') {
      void this.connect();
    }
  }

  get #connection(): Connection {
    return { baseUrl: this.#urlInput.value.trim(), apiKey: this.#keyInput.value.trim() };
  }

  #renderReach(readiness: Readiness | undefined, isChecked: boolean): void {
    const gateway = gatewayReach(readiness, isChecked);
    const integration = (name: string): IntegrationStatus | 'unknown' =>
      readiness?.checks.integrations?.[name]?.status ?? 'unknown';
    replaceChildren(this.#reach, [
      reachBadge('gateway', gateway),
      reachBadge('cryptopay', integration('cryptopay')),
      reachBadge('whatsapp', integration('whatsappNotification')),
    ]);
  }

  async #create(request: CreatePaymentRequest): Promise<void> {
    const connection = this.#connection;
    if (connection.apiKey === '') {
      this.#form.showProblem('Enter the gateway API key first.');
      return;
    }
    clearTimeout(this.#pollTimer);
    this.#walletNote = undefined;
    this.#form.setBusy(true);
    const created = await createPayment(connection, request, `demo-${crypto.randomUUID()}`);
    this.#form.setBusy(false);
    if (!created.ok) {
      this.#form.showProblem(describeFailure(created.failure, connection.baseUrl));
      return;
    }
    if (created.body.failureReason !== undefined) {
      // A payment row exists and says why it could not be served; it is read
      // back like any other so the record, not this page, tells the story.
      this.#form.showProblem(created.body.failureReason);
    }
    await this.#poll(created.body.id);
  }

  async #poll(paymentId: string): Promise<void> {
    const result = await readPayment(this.#connection, paymentId);
    if (!result.ok) {
      this.#form.showProblem(describeFailure(result.failure, this.#connection.baseUrl));
      // A read that failed says nothing about the payment; ask again.
      this.#pollTimer = setTimeout(() => void this.#poll(paymentId), pollMilliseconds * 2);
      return;
    }
    this.#current = result.body;
    this.#render();
    if (!readLifecycle(result.body).isSettling) {
      return;
    }
    this.#pollTimer = setTimeout(() => void this.#poll(paymentId), pollMilliseconds);
  }

  #render(): void {
    if (this.#current === undefined) {
      renderEmpty(this.#paymentTarget);
      return;
    }
    renderPayment(
      this.#paymentTarget,
      this.#current,
      {
        onCopy: async (value) => {
          await navigator.clipboard.writeText(value);
        },
        onPayWithWallet: async (uri) => {
          try {
            const hash = await payWithWallet(uri);
            this.#walletNote = `The wallet broadcast ${hash}. The provider will see it on its next scan.`;
          } catch (error) {
            this.#walletNote = error instanceof Error ? error.message : 'The wallet refused.';
          }
          this.#render();
        },
        onNewPayment: () => {
          clearTimeout(this.#pollTimer);
          this.#current = undefined;
          this.#walletNote = undefined;
          this.#render();
        },
      },
      this.#walletNote,
    );
  }

  public async connect(): Promise<void> {
    const connection = this.#connection;
    store(storageKeys.url, connection.baseUrl);
    store(storageKeys.key, connection.apiKey);
    this.#connectionNote.textContent = 'Connecting…';

    const readiness = await readReadiness(connection.baseUrl);
    this.#renderReach(readiness, true);
    if (readiness === undefined) {
      this.#form.setOptions(undefined);
      this.#connectionNote.textContent = describeFailure(
        { status: 0, code: 'unreachable', message: '' },
        connection.baseUrl,
      );
      return;
    }
    if (connection.apiKey === '') {
      this.#form.setOptions(undefined);
      this.#connectionNote.textContent =
        'The gateway is up. Enter an API key to see what it can serve.';
      return;
    }
    const options = await readPaymentOptions(connection);
    if (!options.ok) {
      this.#form.setOptions(undefined);
      this.#connectionNote.textContent = describeFailure(options.failure, connection.baseUrl);
      return;
    }
    this.#form.setOptions(options.body);
    const served = options.body.methods
      .filter((entry) => entry.providers.length > 0)
      .map((entry) => entry.method);
    this.#connectionNote.textContent = `Connected to the ${options.body.environment.toLowerCase()} environment. Methods served here: ${served.length === 0 ? 'none' : served.join(', ')}.`;
  }
}

new DemoCheckout(document);
