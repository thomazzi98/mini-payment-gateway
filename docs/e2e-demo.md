# The end-to-end demonstration

Four repositories, one flow, nothing substituted:

```
portfolio ──► payment gateway ──► CryptoPay ──► destination on a local chain
                   ▲                  │
                   │                  │  the customer pays; CryptoPay scans, confirms,
                   │                  │  and delivers a signed webhook
                   │◄─────────────────┘
                   │  the gateway verifies the signature, schedules an authenticated
                   │  read, confirms on the read, writes payment.paid in the same
                   │  transaction as the money
                   ▼
   WhatsApp Notification Platform ──► WAHA ──► the customer's phone
```

Every arrow is an HTTP call between independently deployed services with their
own databases. The gateway holds a CryptoPay API key and a notification platform
API key; CryptoPay holds nothing of the gateway's but a callback URL and the
secret it signs with; the notification platform holds nothing of either.

## Running it

Three sibling checkouts (`../cryptopay`, `../whatsapp-notification-platform`,
overridable with `CRYPTOPAY_DIR` and `WHATSAPP_DIR`), Docker, and a `.env` in
each repository — CryptoPay's needs `API_KEY_PEPPER` and
`WALLET_KEY_ENCRYPTION_KEY`; the notification platform's comes from
`pnpm setup:env`; this one's from `.env.example`.

```bash
node scripts/demo-stack.mjs up
```

That brings up CryptoPay beside an Anvil chain (its `docker-compose.local-chain.yml`
overlay: block every two seconds, a mock USDC at a deterministic address, a funded
payer), the notification platform with its deterministic WAHA stub, and this
gateway joined to both over one Docker network. It then provisions what each
stack exposes through its own surface — a CryptoPay key and signing secret, a
notification tenant, key and paired connection, a gateway organization and key —
and hands each credential to the stack that must present it, through `.env.demo`
(gitignored). It prints the gateway key once, and the command to run the flow:

```bash
GATEWAY_API_KEY=… WHATSAPP_API_KEY=… npm run test:e2e
```

`status`, `down` and `reset` do what they say; `reset` discards every volume,
including the chain, which is the answer to any cursor that has outrun a chain
restarted without its state.

## What the test proves

`e2e/crypto-payment-flow.e2e.test.ts` drives the flow as a merchant and as the
customer's wallet, and observes it only through public surfaces:

1. `POST /v1/payments` with `paymentMethod: crypto` answers 201 with a destination,
   an EIP-681 URI and a QR code that CryptoPay rendered — and the same bytes again
   on the same idempotency key.
2. `GET /v1/payments/:id` reads the stored instrument back with CryptoPay as the
   provider and its `pay_…` reference on the attempt.
3. The test pays the URI exactly, as a wallet would: an ERC-20 transfer sent from
   the chain's unlocked payer account, and the destination's balance moves by the
   requested amount.
4. CryptoPay detects the transfer, holds it to its confirmation count, marks the
   payment complete, and delivers `payment.completed` signed as a Standard Webhook.
   The gateway records the notification with disposition `scheduled_read`, and
   the transition into `paid` carries `PAYMENT_CONFIRMED` with
   `authenticated_provider_read` — the read decided, the webhook only prompted it.
5. One `payment.paid` event exists and reads back as `delivered` with the
   notification platform's identifier, after one attempt.
6. The platform holds one notification for that payment, addressed to the phone
   the payment carried, with the amount in the asset, and it reaches the WAHA
   stub: `providerMessageId` is set and the status is `SENT`.
7. A forged redelivery of the provider event is refused before it is read, and
   changes nothing: still one funded transition, still one event.
8. Another key cannot read the payment.

Observed on this machine, the whole sequence — creation to the stub acknowledging
the message — takes about twelve seconds, most of it the chain's two-second
blocks and CryptoPay's two required confirmations.

## What is real and what stands in

| Piece                                | In the demonstration                                                        |
| ------------------------------------ | --------------------------------------------------------------------------- |
| The gateway, CryptoPay, the platform | The real services, built from their repositories, on their own databases    |
| The chain                            | Anvil: a real EVM, local, mining on a timer. Not Polygon.                   |
| USDC                                 | A six-decimal ERC-20 deployed on that chain. Not Circle's contract.         |
| CryptoPay's scanning and finality    | Real, against that chain; the local network has no finality tag to wait for |
| The signed webhook                   | Real: signed by CryptoPay, verified here against the raw bytes              |
| WhatsApp                             | The platform's WAHA stub answers as WAHA's NOWEB engine does. No phone      |

Pointing the notification platform at a real WAHA is its `whatsapp` compose
profile and a phone to pair; nothing in the gateway changes. Pointing CryptoPay
at Polygon Amoy is removing the local-chain overlay and funding a wallet; nothing
in the gateway changes either.

## Appmax

The Pix provider is not part of this flow and is not exercised by it. It remains
implemented and tested against a controlled transport, and has not been validated
against the Appmax sandbox because no credentials exist for it. See
[limitations.md](limitations.md).
