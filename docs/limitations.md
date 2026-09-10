# Limitations

What this system does not do, stated without hedging. A limitations document that
reads like marketing is worse than none, because it teaches the reader to skip it.

Everything here is current as of the reconciliation milestone. Each entry says
what is missing, what it costs, and what happens meanwhile.

## Live Appmax integration has not been performed end to end

**A real Pix has never been created.** No order, no QR code, no payment.

What has actually reached Appmax is one HTTPS request to
`auth.sandboxappmax.com.br/oauth2/token` with deliberately invalid credentials,
which returned `401 invalid_client` and was correctly classified as an
authentication failure. That proves egress works from inside the container, that
TLS terminates, and that the OAuth2 request shape is accepted well enough to be
rejected on credentials rather than on form. It proves nothing about order
creation, Pix creation, response parsing against real payloads, or webhooks.

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

## No webhooks, in either direction

Appmax webhooks are not ingested, and merchants receive no callbacks.

Reconciliation observes a payment only while it is `unknown`. A payment that
reached `awaiting_payment` normally and is then paid by the customer is **not**
observed by anything: there is no webhook path, and the worker does not poll
payments that are merely waiting. Confirming an ordinary payment is the next gap
to close, and it is the one that matters most for a working gateway.

The schema is ready for this — a funds-bearing transition requires
`authenticated_provider_read` evidence, so a forged webhook is structurally
incapable of marking a payment paid — but none of the machinery is built.

## Only Pix, only BRL, only creation

- No card, no boleto. These are declared unsupported capabilities rather than
  stubbed, so a payment method the gateway cannot serve is refused rather than
  silently accepted.
- No refunds, despite `RefundCapableProvider` existing on the Appmax adapter.
- No payment retrieval endpoint. A payment can be created and never read back over
  HTTP.
- Currency is fixed to BRL at the edge.

## Failover is bounded and does not retry the same provider

A provider outcome that proves nothing was created moves to the next candidate,
and the candidates are exhausted once. `canRetrySameProvider` exists in the
taxonomy and is not acted on: a transport failure moves to the next provider
rather than retrying the one that failed. That is safe but less capable than the
taxonomy allows, and with a single provider configured it means a transient
connection failure fails the payment.

## No dashboard, no hosted checkout, no notifications

None of the merchant-facing surfaces exist. Specifically absent: the admin
dashboard and everything configurable through it, the sandbox test mode, the
hosted checkout page, the notification channel port, and the WhatsApp adapter.

Provider credentials therefore come from environment variables rather than from
per-organization configuration in the database. Adding a second organization with
its own Appmax account is not currently possible.

## No rate limiting

Redis is running and unused. Nothing limits how fast an API key can create
payments.

## Configuration is process-wide, not per-tenant

One Appmax registration serves every organization, bound to the single
environment its credentials belong to. A payment in the other environment finds
no provider and is refused, which is the safe failure, but it means production and
sandbox cannot both be served by one process.

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
- A payment cannot be recorded paid on evidence weaker than a provider read, and
  an edge the transition table does not declare is refused whatever the caller
  believes.

They do not prove:

- That the Appmax adapter parses a real Appmax response. Every provider test uses
  a controlled transport.
- That the system behaves correctly under a real provider outage, as opposed to a
  simulated one.
- That a payment is ever confirmed as paid in ordinary operation, because nothing
  observes a payment that is merely waiting.
- That the stack survives a process being killed mid-payment. The worker's loop is
  tested for restart and shutdown behaviour, and a lease is proven to be released
  rather than held, but no test kills an actual process mid-payment.

## Known operational sharp edge

`docker compose up` reuses one-shot containers that have already completed, so a
new migration is not applied unless the image is rebuilt. Use
`docker compose up --build`. This bit during development and would bite an
operator the same way.
