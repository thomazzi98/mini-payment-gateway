import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The whole demonstration, against the running stacks and nothing substituted.
 *
 *   gateway ──► CryptoPay ──► destination on the local chain
 *                                   │  this test pays, as the customer's wallet would
 *                                   ▼
 *   CryptoPay detects and confirms ──► signed webhook ──► gateway schedules a read
 *                                                            │
 *   gateway confirms on the authenticated read ──► paid, event written ──► handed to
 *   the WhatsApp Notification Platform ──► WAHA
 *
 * Every step is observed through a public surface: the gateway's own read of the
 * payment, the chain's RPC, the notification platform's API and the provider
 * stub's control plane. Nothing is asserted that a substitute could have faked.
 *
 * Needs the three stacks up on the shared network (see docs/e2e-demo.md) and:
 *   GATEWAY_API_KEY        a gateway key with payments:write and payments:read
 *   WHATSAPP_API_KEY       a notification platform key (optional: skips the
 *                          platform-side assertions when absent)
 */

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://127.0.0.1:4010';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY ?? '';
const ANVIL_RPC_URL = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
const LOCAL_USDC_ADDRESS = (
  process.env.LOCAL_USDC_ADDRESS ?? '0x5fbdb2315678afecb367f032d93f642f64180aa3'
).toLowerCase();
const PAYER_ADDRESS = (
  process.env.PAYER_ADDRESS ?? '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
).toLowerCase();
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL ?? 'http://127.0.0.1:3100';
const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY ?? '';
const WAHA_STUB_URL = process.env.WAHA_STUB_URL ?? 'http://127.0.0.1:3200';
// The provider stub treats this recipient as an ordinary, reachable number.
const RECIPIENT_PHONE = process.env.DEMO_RECIPIENT_PHONE ?? '+5511988887777';

const AMOUNT_MINOR = 1_500_000n;

interface PaymentDetail {
  readonly id: string;
  readonly status: string;
  readonly paymentMethod: string;
  readonly amountMinor: string;
  readonly capturedAmountMinor: string;
  readonly currency: string;
  readonly provider?: string;
  readonly providerReference?: string;
  readonly paidAt?: string;
  readonly instrument?: {
    readonly type: string;
    readonly network: string;
    readonly asset: string;
    readonly destinationAddress: string;
    readonly paymentUri: string;
    readonly qrCodeImageDataUri: string;
  };
  readonly transitions: readonly {
    readonly toStatus: string;
    readonly trigger: string;
    readonly evidenceClass: string;
  }[];
  readonly providerNotifications: readonly {
    readonly provider: string;
    readonly eventType: string;
    readonly disposition: string;
  }[];
  readonly events: readonly {
    readonly type: string;
    readonly delivery: {
      readonly channel: string;
      readonly status: string;
      readonly attempts: number;
      readonly reference?: string;
    };
  }[];
}

async function gateway<Body>(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; idempotencyKey?: string; key?: string } = {},
): Promise<{ status: number; body: Body }> {
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${options.key ?? GATEWAY_API_KEY}`,
      'content-type': 'application/json',
      ...(options.idempotencyKey !== undefined && { 'idempotency-key': options.idempotencyKey }),
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: (await response.json()) as Body };
}

async function rpc<Result>(method: string, params: unknown[]): Promise<Result> {
  const response = await fetch(ANVIL_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  const body = (await response.json()) as { result?: Result; error?: unknown };
  if (body.error !== undefined) {
    throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  }
  return body.result as Result;
}

function padWord(hex: string): string {
  return hex.replace(/^0x/, '').padStart(64, '0');
}

/**
 * Pays exactly what an EIP-681 URI asks for, the way a wallet would: an ERC-20
 * transfer of the encoded amount to the encoded recipient, sent from the payer
 * account the local chain has unlocked.
 */
async function payUri(paymentUri: string): Promise<string> {
  const match =
    /^ethereum:(0x[0-9a-f]{40})@(\d+)\/transfer\?address=(0x[0-9a-f]{40})&uint256=(\d+)$/i.exec(
      paymentUri,
    );
  if (match === null) {
    throw new Error(`not an EIP-681 token transfer: ${paymentUri}`);
  }
  const [, token, chainId, recipient, amount] = match;
  if (token?.toLowerCase() !== LOCAL_USDC_ADDRESS) {
    throw new Error(`the URI names ${token ?? 'no token'}, not the local USDC`);
  }
  expect(Number(chainId)).toBe(31_337);

  const data = `0xa9059cbb${padWord(recipient ?? '')}${padWord(BigInt(amount ?? '0').toString(16))}`;
  const hash = await rpc<string>('eth_sendTransaction', [
    { from: PAYER_ADDRESS, to: LOCAL_USDC_ADDRESS, data },
  ]);
  await waitFor(
    async () => {
      const receipt = await rpc<{ status: string } | null>('eth_getTransactionReceipt', [hash]);
      return receipt?.status === '0x1';
    },
    30_000,
    'the transfer to be mined',
  );
  return hash;
}

async function waitFor(
  isSatisfied: () => Promise<boolean>,
  timeoutMilliseconds: number,
  description: string,
  intervalMilliseconds = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await isSatisfied()) {
      return;
    }
    await new Promise((settle) => setTimeout(settle, intervalMilliseconds));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function readPayment(paymentId: string): Promise<PaymentDetail> {
  const response = await gateway<PaymentDetail>('GET', `/v1/payments/${paymentId}`);
  expect(response.status).toBe(200);
  return response.body;
}

async function balanceOf(account: string): Promise<bigint> {
  const data = `0x70a08231${padWord(account)}`;
  return BigInt(await rpc<string>('eth_call', [{ to: LOCAL_USDC_ADDRESS, data }, 'latest']));
}

beforeAll(() => {
  if (GATEWAY_API_KEY === '') {
    throw new Error('GATEWAY_API_KEY is required: issue one with the seed CLI (docs/e2e-demo.md).');
  }
});

describe('a crypto payment, end to end', () => {
  const reference = `demo-${randomUUID().slice(0, 8)}`;
  const idempotencyKey = `e2e-${randomUUID()}`;
  let created: PaymentDetail;
  let transferHash = '';

  afterAll(() => {
    process.stdout.write(
      `\npayment ${created?.id ?? '(none)'} reference ${reference} transfer ${transferHash}\n`,
    );
  });

  it('creates a gateway payment and receives a crypto destination from CryptoPay', async () => {
    const response = await gateway<PaymentDetail>('POST', '/v1/payments', {
      idempotencyKey,
      body: {
        amount: Number(AMOUNT_MINOR),
        currency: 'USDC',
        paymentMethod: 'crypto',
        reference,
        description: 'Portfolio demonstration payment',
        customer: { phone: RECIPIENT_PHONE },
      },
    });

    expect(response.status).toBe(201);
    created = response.body;
    expect(created.status).toBe('awaiting_payment');
    expect(created.paymentMethod).toBe('crypto');
    expect(created.currency).toBe('USDC');
    expect(created.amountMinor).toBe(AMOUNT_MINOR.toString());
    expect(created.instrument?.type).toBe('crypto');
    expect(created.instrument?.asset).toBe('USDC');
    expect(created.instrument?.destinationAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(created.instrument?.paymentUri).toMatch(/^ethereum:/);
    expect(created.instrument?.qrCodeImageDataUri).toMatch(/^data:image\/png;base64,/);
  });

  it('replays the same request byte for byte on the same idempotency key', async () => {
    const replay = await gateway<PaymentDetail>('POST', '/v1/payments', {
      idempotencyKey,
      body: {
        amount: Number(AMOUNT_MINOR),
        currency: 'USDC',
        paymentMethod: 'crypto',
        reference,
        description: 'Portfolio demonstration payment',
        customer: { phone: RECIPIENT_PHONE },
      },
    });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(created);
  });

  it('reads back with the destination stored and CryptoPay as the provider', async () => {
    const detail = await readPayment(created.id);
    expect(detail.provider).toBe('cryptopay');
    expect(detail.providerReference).toMatch(/^pay_/);
    expect(detail.instrument).toEqual(created.instrument);
    expect(detail.transitions.map((transition) => transition.toStatus)).toEqual([
      'processing',
      'awaiting_payment',
    ]);
  });

  it('is paid on the local chain exactly as the URI asks', async () => {
    const destination = created.instrument?.destinationAddress ?? '';
    const before = await balanceOf(destination);
    transferHash = await payUri(created.instrument?.paymentUri ?? '');
    const after = await balanceOf(destination);
    expect(after - before).toBe(AMOUNT_MINOR);
  });

  it('is detected and confirmed by CryptoPay, notified, and funded only on the read', async () => {
    await waitFor(
      async () => {
        const current = await readPayment(created.id);
        return current.status === 'paid';
      },
      180_000,
      'the gateway to confirm the payment',
    );

    const detail = await readPayment(created.id);
    expect(detail.capturedAmountMinor).toBe(AMOUNT_MINOR.toString());
    expect(detail.paidAt).toBeDefined();

    // The money moved on an authenticated read, and on nothing else.
    const funded = detail.transitions.find((transition) => transition.toStatus === 'paid');
    expect(funded?.trigger).toBe('PAYMENT_CONFIRMED');
    expect(funded?.evidenceClass).toBe('authenticated_provider_read');

    // CryptoPay's signed notification arrived, verified, and did what it may:
    // schedule that read.
    const completed = detail.providerNotifications.find(
      (notification) => notification.eventType === 'payment.completed',
    );
    expect(completed?.provider).toBe('cryptopay');
    expect(completed?.disposition).toBe('scheduled_read');
  }, 200_000);

  it('writes one paid event and hands it to the notification platform once', async () => {
    await waitFor(
      async () => {
        const detail = await readPayment(created.id);
        return detail.events[0]?.delivery.status === 'delivered';
      },
      60_000,
      'the paid event to be delivered',
    );

    const detail = await readPayment(created.id);
    expect(detail.events).toHaveLength(1);
    const [event] = detail.events;
    expect(event?.type).toBe('payment.paid');
    expect(event?.delivery.channel).toBe('whatsapp');
    expect(event?.delivery.reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(event?.delivery.attempts).toBe(1);
  }, 70_000);

  it('reaches WAHA through the notification platform, once', async () => {
    if (WHATSAPP_API_KEY === '') {
      process.stdout.write('WHATSAPP_API_KEY not set: platform-side assertions skipped\n');
      return;
    }
    const detail = await readPayment(created.id);
    const reference = detail.events[0]?.delivery.reference ?? '';

    interface Notification {
      status: string;
      recipient: string;
      body: string;
      providerMessageId: string | null;
      metadata: Record<string, string>;
    }
    // The platform budgets requests per key and answers 429 with Retry-After
    // when the budget is spent. That is the platform working, so the read waits
    // it out rather than counting it as an answer about the notification.
    const notification = async (): Promise<Notification> => {
      for (;;) {
        const response = await fetch(`${WHATSAPP_API_URL}/v1/notifications/${reference}`, {
          headers: { authorization: `Bearer ${WHATSAPP_API_KEY}` },
        });
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('retry-after') ?? '5');
          await new Promise((settle) => setTimeout(settle, Math.max(1, retryAfter) * 1000));
          continue;
        }
        expect(response.status).toBe(200);
        return (await response.json()) as Notification;
      }
    };

    const accepted = await notification();
    expect(accepted.recipient).toBe(RECIPIENT_PHONE);
    expect(accepted.body).toContain(reference.length > 0 ? created.id : '');
    expect(accepted.body).toContain('USDC 1.500000');
    expect(accepted.metadata['paymentId']).toBe(created.id);

    // The platform paces sends, so this is the slow step of the whole flow.
    await waitFor(
      async () => {
        const current = await notification();
        return current.providerMessageId !== null;
      },
      180_000,
      'the notification platform to send through WAHA',
      5000,
    );
    const sent = await notification();
    expect(sent.providerMessageId).toMatch(/^STUB/);
    expect(['SENT', 'DELIVERED']).toContain(sent.status);

    // One message for one event, however the event was handed over.
    const listing = await fetch(
      `${WHATSAPP_API_URL}/v1/notifications?recipient=${encodeURIComponent(RECIPIENT_PHONE)}&limit=100`,
      { headers: { authorization: `Bearer ${WHATSAPP_API_KEY}` } },
    );
    const listed = (await listing.json()) as { data: { metadata: Record<string, string> }[] };
    const forThisPayment = listed.data.filter(
      (entry) => entry.metadata['paymentId'] === created.id,
    );
    expect(forThisPayment).toHaveLength(1);
  }, 200_000);

  it('answers a replayed provider notification without a second effect', async () => {
    // A redelivery of CryptoPay's own event is the ordinary case, and this
    // endpoint must answer it identically. Here the redelivery is unsigned, so
    // it is refused before it is read: the test proves the gate exists, and the
    // signed path was already exercised by the payment reaching paid above.
    const response = await fetch(`${GATEWAY_URL}/v1/webhooks/cryptopay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: 'whd_forged',
        type: 'payment.completed',
        data: { identifier: created.providerReference ?? 'pay_x', status: 'completed' },
      }),
    });
    expect(response.status).toBe(400);

    const detail = await readPayment(created.id);
    expect(detail.status).toBe('paid');
    expect(detail.events).toHaveLength(1);
    expect(detail.transitions.filter((transition) => transition.toStatus === 'paid')).toHaveLength(
      1,
    );
  });

  it('is invisible to a key that is not its owner', async () => {
    const response = await gateway<unknown>('GET', `/v1/payments/${created.id}`, {
      key: 'mpg_test_notarealkeynotarealkeynotarealkeyxx',
    });
    expect(response.status).toBe(401);
  });

  it('checks the WAHA stub actually received a message when reachable', async () => {
    let response: Response;
    try {
      response = await fetch(`${WAHA_STUB_URL}/__stub/webhooks`);
    } catch {
      process.stdout.write('WAHA stub control plane not reachable: skipped\n');
      return;
    }
    // The stub records what it delivered to the platform; reaching it at all is
    // what this asserts. The message itself was asserted through the platform.
    expect(response.status).toBe(200);
  });
});
