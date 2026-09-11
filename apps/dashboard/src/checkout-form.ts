import { decimalsOf, formatAmount, maximumMinor, parseAmount } from './amounts';
import { element, replaceChildren, requireElement } from './dom';
import type { CreatePaymentRequest, PaymentOptions } from './gateway-client';

/**
 * The left-hand side of the screen: what to ask the gateway for.
 *
 * Methods, currencies and networks come from the gateway's own answer about
 * what it can serve. A method with no provider here is shown, disabled, with
 * the reason, rather than hidden or pretended.
 */

type Method = 'crypto' | 'pix';

export interface FormSelection {
  readonly method: Method;
  readonly currency: string;
  readonly network: string;
  readonly amount: string;
  readonly phone: string;
}

export interface FormHandlers {
  readonly onChange: (selection: FormSelection) => void;
  readonly onSubmit: (request: CreatePaymentRequest) => void;
}

const phonePattern = /^\+[1-9]\d{7,14}$/;

const methodLabels: Readonly<Record<Method, { readonly title: string; readonly note: string }>> = {
  crypto: { title: 'Crypto', note: 'A destination on a chain, confirmed by the provider' },
  pix: { title: 'PSP · Pix', note: 'Appmax. Implemented; sandbox credentials required' },
};

const providersFor = (options: PaymentOptions | undefined, method: Method) =>
  options?.methods.find((entry) => entry.method === method)?.providers ?? [];

interface FormValidation {
  readonly request?: CreatePaymentRequest;
  readonly problem?: string;
}

/**
 * The request the selection amounts to, or the one thing wrong with it. Pure,
 * so the rules are testable without a screen.
 */
export function validateSelection(
  selection: FormSelection,
  options: PaymentOptions | undefined,
  reference: string,
): FormValidation {
  const providers = providersFor(options, selection.method);
  if (providers.length === 0) {
    return { problem: `No provider can serve ${methodLabels[selection.method].title} here.` };
  }
  const amount = parseAmount(selection.amount, selection.currency);
  if (amount === undefined) {
    return {
      problem: `Enter an amount above zero with at most ${String(decimalsOf(selection.currency))} decimals, up to ${formatAmount(String(maximumMinor), selection.currency)}.`,
    };
  }
  const phone = selection.phone.trim();
  if (phone !== '' && !phonePattern.test(phone)) {
    return { problem: 'The phone must be international, such as +5511999998888, or empty.' };
  }
  if (selection.method === 'pix') {
    return {
      problem: 'Pix needs the customer the bank will name; this checkout does not collect it.',
    };
  }
  if (providers.every((provider) => !provider.networks.includes(selection.network))) {
    return { problem: 'Choose a network the gateway offers.' };
  }
  return {
    request: {
      paymentMethod: 'crypto',
      amount,
      currency: selection.currency,
      network: selection.network,
      reference,
      description: 'Demo checkout',
      ...(phone !== '' && { customer: { phone } }),
    },
  };
}

interface FormElements {
  readonly form: HTMLFormElement;
  readonly methods: HTMLElement;
  readonly currency: HTMLSelectElement;
  readonly network: HTMLSelectElement;
  readonly amount: HTMLInputElement;
  readonly phone: HTMLInputElement;
  readonly submit: HTMLButtonElement;
  readonly problem: HTMLElement;
  readonly providerNote: HTMLElement;
}

function option(value: string, label = value): HTMLOptionElement {
  return element('option', { value }, [label]);
}

export class CheckoutForm {
  readonly #elements: FormElements;

  readonly #handlers: FormHandlers;

  #options: PaymentOptions | undefined;

  #selection: FormSelection = {
    method: 'crypto',
    currency: 'USDC',
    network: '',
    amount: '1.50',
    phone: '',
  };

  #busy = false;

  public constructor(root: HTMLFormElement, handlers: FormHandlers) {
    this.#handlers = handlers;
    this.#elements = {
      form: root,
      methods: requireElement(root, '[data-methods]', 'div'),
      currency: requireElement(root, '[data-currency]', 'select'),
      network: requireElement(root, '[data-network]', 'select'),
      amount: requireElement(root, '[data-amount]', 'input'),
      phone: requireElement(root, '[data-phone]', 'input'),
      submit: requireElement(root, '[data-submit]', 'button'),
      problem: requireElement(root, '[data-problem]', 'p'),
      providerNote: requireElement(root, '[data-provider-note]', 'p'),
    };
    this.#bind();
    this.#renderMethods();
    this.#renderChoices();
  }

  #bind(): void {
    const { form, amount, phone, currency, network } = this.#elements;
    amount.addEventListener('input', () => {
      this.#update({ amount: amount.value });
    });
    phone.addEventListener('input', () => {
      this.#update({ phone: phone.value });
    });
    currency.addEventListener('change', () => {
      this.#update({ currency: currency.value });
    });
    network.addEventListener('change', () => {
      this.#update({ network: network.value });
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.#busy) {
        return;
      }
      const reference = `demo-${crypto.randomUUID().slice(0, 8)}`;
      const validation = validateSelection(this.#selection, this.#options, reference);
      if (validation.request === undefined) {
        this.showProblem(validation.problem);
        return;
      }
      this.showProblem(undefined);
      this.#handlers.onSubmit(validation.request);
    });
  }

  #update(changes: Partial<FormSelection>): void {
    this.#selection = { ...this.#selection, ...changes };
    this.showProblem(undefined);
    this.#handlers.onChange(this.#selection);
  }

  #renderMethods(): void {
    const buttons = (['crypto', 'pix'] as const).map((method) => {
      const providers = providersFor(this.#options, method);
      const isAvailable = providers.length > 0;
      const button = element(
        'button',
        {
          type: 'button',
          class: 'method',
          role: 'radio',
          'aria-checked': this.#selection.method === method ? 'true' : 'false',
          'data-available': isAvailable ? 'true' : 'false',
        },
        [
          element('span', { class: 'method__title' }, [methodLabels[method].title]),
          element('span', { class: 'method__note' }, [
            isAvailable
              ? providers.map((provider) => provider.displayName).join(', ')
              : methodLabels[method].note,
          ]),
        ],
      );
      button.addEventListener('click', () => {
        this.#update({ method });
        this.#renderMethods();
        this.#renderChoices();
      });
      return button;
    });
    replaceChildren(this.#elements.methods, buttons);
  }

  #renderChoices(): void {
    const { currency, network, submit, providerNote, phone, amount } = this.#elements;
    const providers = providersFor(this.#options, this.#selection.method);
    const currencies = [...new Set(providers.flatMap((provider) => provider.currencies))];
    const networks = [...new Set(providers.flatMap((provider) => provider.networks))];

    replaceChildren(
      currency,
      currencies.map((code) => option(code)),
    );
    currency.value = this.#selection.currency;
    currency.disabled = currencies.length <= 1;

    const networkField = network.closest('[data-field]');
    if (networkField instanceof HTMLElement) {
      networkField.hidden = this.#selection.method !== 'crypto';
    }
    replaceChildren(
      network,
      networks.map((name) => option(name)),
    );
    network.value = this.#selection.network;
    network.disabled = networks.length <= 1;

    amount.value = this.#selection.amount;
    phone.value = this.#selection.phone;

    const isServed = providers.length > 0;
    submit.disabled = !isServed || this.#busy;
    providerNote.textContent = this.#describeService(providers);
  }

  #describeService(providers: PaymentOptions['methods'][number]['providers']): string {
    if (providers.length > 0) {
      return `Served by ${providers.map((provider) => provider.displayName).join(', ')}.`;
    }
    if (this.#options === undefined) {
      return 'Connect to the gateway to see what it can serve.';
    }
    return `No ${methodLabels[this.#selection.method].title} provider is registered for this environment.`;
  }

  public get selection(): FormSelection {
    return this.#selection;
  }

  public setOptions(options: PaymentOptions | undefined): void {
    this.#options = options;
    const crypto = providersFor(options, 'crypto');
    const currency = crypto.flatMap((provider) => provider.currencies)[0] ?? 'USDC';
    const network = crypto.flatMap((provider) => provider.networks)[0] ?? '';
    this.#selection = { ...this.#selection, currency, network };
    this.#renderMethods();
    this.#renderChoices();
  }

  public setBusy(isBusy: boolean): void {
    this.#busy = isBusy;
    this.#elements.submit.disabled = isBusy;
    this.#elements.submit.textContent = isBusy ? 'Creating…' : 'Create payment';
  }

  public showProblem(problem: string | undefined): void {
    this.#elements.problem.textContent = problem ?? '';
    this.#elements.problem.hidden = problem === undefined;
  }
}
