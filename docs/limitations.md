# Limitations

What this system does not do, stated without hedging. A limitations document that
reads like marketing is worse than none, because it teaches the reader to skip it.

Everything here is current as of the cross-repository integration. Each entry
says what is missing, what it costs, and what happens meanwhile.

**What has been validated end to end is the crypto flow, not the Pix one.** A
payment created here through CryptoPay, paid on a local chain, confirmed on an
authenticated read, and delivered as a WhatsApp notification through the
platform's provider stub has been executed and asserted against the running
stacks — see [e2e-demo.md](e2e-demo.md). The Pix flow through Appmax has not,
for the reason in the next section.

## Live Appmax integration has not been performed end to end

**A real Pix has never been created.** No order, no QR code, no payment.

What has actually reached Appmax is one HTTPS request to
`auth.sandboxappmax.com.br/oauth2/token` with deliberately invalid credentials,
which returned `401 invalid_client` and was correctly classified as an
authentication failure. That proves egress works from inside the container, that
TLS terminates, and that the OAuth2 request shape is accepted well enough to be
rejected on credentials rather than on form.

Stated plainly:

```
Real Pix creation:            NOT VERIFIED — no Sandbox credentials.
Real Appmax webhook delivery: NOT VERIFIED — no externally authenticated
                              provider environment.
Real Appmax reconciliation:   NOT VERIFIED.
```

**The webhook envelope shape is unverified in particular.** The event names are
documented and the parser handles them; the exact JSON layout Appmax posts has
never been seen, because that needs a developer account this project does not
have. The parser therefore reads defensively from the layouts the documentation
implies and refuses what it cannot recognise, rather than asserting one shape is
the shape. The fixtures in `appmax-webhook.test.ts` are what to check a real
delivery against.

That uncertainty is deliberately not load-bearing. A notification this parser
misreads costs a scheduled read; the payment is still polled on its ordinary
cadence and still resolved by an authenticated inquiry, so the worst case is
latency rather than a lost payment.

Sandbox credentials require an Appmax developer account, which requires an active
CNPJ. Until `APPMAX_CLIENT_ID` and `APPMAX_CLIENT_SECRET` exist,
`npm run validate:appmax` exits 78 with an actionable message and says plainly
that nothing was validated. It does not pretend to pass.

The adapter is therefore written against the published documentation and tested
against a controlled transport. Two documented inconsistencies in the Pix response
shape are handled defensively because the documentation contradicts itself about
them, and which one is real will only be known when a live call is made.

## Reconciliation resolves uncertainty, but only what a provider will answer

A reconciliation worker now discovers uncertain payments, inquires through the
provider abstraction, and resolves them on authoritative evidence. What it cannot
do is bounded and deliberate:

- **A payment whose attempt never recorded a provider reference cannot be
  resolved by inquiry at all.** Appmax offers no order search, so there is nothing
  to ask about. Only a person can close these.
- **After a bounded number of fruitless inquiries the worker stops asking.** The
  payment stays `unknown` and unlocked, and becomes an operator's. That backlog is
  counted at worker startup; nothing yet alerts on it.
- **A provider that reports an amount other than the one expected is not
  resolved.** This is correct — a Pix code carries a fixed amount, so a
  disagreement means the reference is not the payment we think it is — but it
  means such payments accumulate for an operator.
- **A claim stranded by a crash clears once the sweep runs**, which is bounded by
  the staleness threshold rather than immediate. Until then a retry of that key is
  told the request is still being processed, which is the truth for the first few
  minutes and stops being it after that. See
  [unknown-outcome-recovery.md](unknown-outcome-recovery.md).
- **Nothing expires an `awaiting_payment` payment whose instrument has lapsed.**
  Expiry is still not driven from the provider's own `expires_at`, so a payment
  whose code has quietly died stays `awaiting_payment` until something asks.

The mechanism has been exercised end to end against a running stack with an
uncertain payment, and the backoff and deferral observed directly. It has **not**
been exercised against a real Appmax response, for the reason in the first
section.

## Merchants receive no callbacks

Provider notifications are ingested; outbound merchant webhooks do not exist. A
merchant learns a payment was paid by reading it back through
`GET /v1/payments/:id`, or by being the customer the WhatsApp notification is
addressed to.

`payment.paid` is delivered to one destination, the WhatsApp Notification
Platform, configured once per process rather than per organization. What the
gateway records is that the platform accepted the message; whether WhatsApp
delivered it is the platform's to report, and the gateway does not read it back.
An event for a payment with no customer phone is closed as skipped rather than
delivered anywhere.

## The crypto demonstration runs on a local chain

The end-to-end flow has been executed against Anvil with a mock six-decimal USDC,
not against Polygon. CryptoPay's scanning, confirmation counting and signed
callbacks are the real code paths; what differs is that a local chain has no
finality tag to wait for and no reorganisations to survive. No crypto payment has
been sent through this gateway on a public network.

An overpaid crypto payment is not funded. CryptoPay reports what actually
arrived, the gateway's rule demands that it equal what was asked, and a larger
amount leaves the payment waiting for an operator — the same rule Pix has, and
the correct one for a fixed-amount instrument, but a documented gap for rails
where paying a little more is ordinary.

## Pix and crypto, creation and reading

- No card, no boleto. These are declared unsupported capabilities rather than
  stubbed, so a payment method the gateway cannot serve is refused rather than
  silently accepted.
- No refunds, despite `RefundCapableProvider` existing on the Appmax adapter.
- No listing. A payment is read back by identifier only.
- Pix is BRL only; crypto is whatever assets the CryptoPay registration is
  configured to offer, USDC by default.

## Failover is bounded and does not retry the same provider

A provider outcome that proves nothing was created moves to the next candidate,
and the candidates are exhausted once. `canRetrySameProvider` exists in the
taxonomy and is not acted on: a transport failure moves to the next provider
rather than retrying the one that failed. That is safe but less capable than the
taxonomy allows, and with a single provider configured it means a transient
connection failure fails the payment.

## No merchant dashboard; the checkout is a demonstration, not a hosted checkout

The admin dashboard and everything configurable through it do not exist, and
neither does a sandbox test mode.

`apps/dashboard` is a checkout page that drives the public API from the browser
and shows a payment settle, stage by stage, from what `GET /v1/payments/:id`
reports. It is a demonstration surface: it holds a merchant API key in the
browser (entered once, kept in `localStorage`), which is what a merchant's own
server would hold and a hosted checkout would never hand to a customer. A hosted
checkout — a per-payment, public, short-lived session that a customer can open
without a merchant credential — is not implemented. The page also shows only
what the gateway itself knows: it can report that the notification platform
accepted the `payment.paid` message, and it does not claim to know whether WAHA
sent it.

Provider and notification credentials come from environment variables rather
than from per-organization configuration in the database. Adding a second
organization with its own Appmax, CryptoPay or notification account is not
currently possible.

## No rate limiting

Redis is running and unused. Nothing limits how fast an API key can create
payments.

## Configuration is process-wide, not per-tenant

One Appmax registration and one CryptoPay registration serve every organization,
each bound to the single environment its credentials belong to. A payment in the
other environment finds no provider and is refused, which is the safe failure, but
it means production and sandbox cannot both be served by one process.

## What the tests do and do not prove

They do prove, against real PostgreSQL:

- The creation cycle writes legal transitions, evidence-backed and append-only.
- Concurrent requests with one idempotency key create exactly one payment.
- Tenant isolation holds for the application role, which owns nothing and cannot
  bypass row-level security.
- Money is integer minor units in every column; no `numeric`, `real`,
  `double precision` or `money` column exists.
- The per-organization ceiling is refused by the database even when the
  application does not check.
- History cannot be rewritten or deleted, including by the role that wrote it.
- Two workers claiming at once never take the same uncertain payment, a lease is
  released rather than held when a worker stops, and a second resolution of the
  same payment is reported as already resolved rather than applied twice.
- A payment abandoned in `processing` is discovered, moved to `unknown`, and its
  idempotency key released, so a retry replays rather than being refused forever.
- A waiting payment is polled, confirmed on an authenticated read, and never made
  uncertain by a failed poll.
- One notification delivered four times concurrently records one row and reports
  one recorded and three duplicates.
- A confirmed payment writes its paid event in the same transaction as the money,
  and a refused transition rolls back both.
- A payment already paid cannot be expired, failed, or confirmed again.
- A payment cannot be recorded paid on evidence weaker than a provider read, and
  an edge the transition table does not declare is refused whatever the caller
  believes.
- A crypto payment stores the destination it was shown, reads back only to its
  owner in its own environment, and its paid event is claimed once per lease,
  cannot be marked delivered without a reference, and is not writable across
  tenants.

They prove, against the running stacks, the whole crypto flow listed in
[e2e-demo.md](e2e-demo.md).

They do not prove:

- That the Appmax adapter parses a real Appmax response. Every provider test uses
  a controlled transport.
- That the system behaves correctly under a real provider outage, as opposed to a
  simulated one.
- That the stack survives a process being killed mid-payment. The worker's loop is
  tested for restart and shutdown behaviour, and a lease is proven to be released
  rather than held, but no test kills an actual process mid-payment.
- That the Appmax webhook parser handles a real Appmax delivery. Every fixture is
  written from documentation, not from a delivery that happened.

## Known operational sharp edge

`docker compose up` reuses one-shot containers that have already completed, so a
new migration is not applied unless the image is rebuilt. Use
`docker compose up --build`. This bit during development and would bite an
operator the same way.
