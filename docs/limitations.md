# Limitations

What this system does not do, stated without hedging. A limitations document that
reads like marketing is worse than none, because it teaches the reader to skip it.

Everything here is current as of the payment-creation milestone. Each entry says
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

## There is no reconciliation worker

This is the largest gap, and several other entries depend on it.

`readPaymentState` is implemented, and every unknown outcome is recorded with the
provider reference needed to resolve it. Nothing schedules that read. No payment
resolves itself, and no `unknown` payment leaves that state without a person.

Consequences:

- A payment whose outcome could not be determined stays `unknown` indefinitely.
- A claim stranded by a crash stays stranded. It is reported honestly as such once
  past its expiry rather than as "retry shortly", but only reconciliation clears
  it. See [unknown-outcome-recovery.md](unknown-outcome-recovery.md).
- Nothing expires an `awaiting_payment` payment whose instrument has lapsed.
  Expiry is not yet driven from the provider's own `expires_at`.

## No webhooks, in either direction

Appmax webhooks are not ingested, and merchants receive no callbacks. A payment
that a customer actually pays will not be observed, because observing it requires
either the webhook path or the polling that does not exist yet.

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

They do not prove:

- That the Appmax adapter parses a real Appmax response. Every provider test uses
  a controlled transport.
- That the system behaves correctly under a real provider outage, as opposed to a
  simulated one.
- Anything about a payment after creation, because nothing after creation exists.
- That the stack survives a process being killed mid-payment. The recovery path is
  designed and recorded but has not been exercised by actually killing anything.

## Known operational sharp edge

`docker compose up` reuses one-shot containers that have already completed, so a
new migration is not applied unless the image is rebuilt. Use
`docker compose up --build`. This bit during development and would bite an
operator the same way.
