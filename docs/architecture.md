# Architecture

How this gateway is put together, and why. Where a decision has a cost, the cost
is named rather than left for the reader to discover.

## Shape

```
merchant
   │  POST /v1/payments, GET /v1/payments/:id, Idempotency-Key, API key
   ▼
api (Fastify)
   │  authenticate → validate → one use case
   ▼
application            provider registry ──► Appmax adapter ────► Appmax (Pix)
   │                                     └──► CryptoPay adapter ─► CryptoPay (crypto)
   ▼                                               ▲
PostgreSQL  ◄──── reconciliation worker ───────────┘
     │
     └──── event delivery worker ──► WhatsApp Notification Platform
```

Two processes, one image, one database:

- **api** serves HTTP, and receives provider notifications.
- **worker** resolves payments whose outcome was never determined, confirms
  payments that are waiting, and hands the paid event on.

Both connect as `payment_gateway_application`, a role that owns nothing, cannot
create anything, and cannot bypass row-level security.

## Layers

```
interface/       HTTP. Thin: authenticate, validate, call one use case, map the outcome.
application/     Use cases and ports. Knows the gateway's vocabulary, no adapters.
domain/          Pure: money, the transition table, the outcome taxonomy, BR Codes.
infrastructure/  Adapters: PostgreSQL, Appmax, logging, configuration.
```

ESLint `no-restricted-imports` zones enforce this: `domain/` may not import
infrastructure, and `application/` may not import an adapter. A violation fails
the build rather than relying on a reviewer noticing.

**Cost:** the wiring is hand-written in `composition-root.ts`. There is no
container, so adding a dependency means editing that file. In exchange every
dependency is greppable and a missing one is a compile error rather than a
boot-time surprise.

## Payment lifecycle

```
pending ──PROVIDER_REQUEST_SENT──► processing
                                       │
        ┌──────────────────────────────┼───────────────────────────┐
        │                              │                           │
  INSTRUMENT_ISSUED           PROVIDER_REFUSED           PROVIDER_OUTCOME_UNKNOWN
        │                              │                           │
        ▼                              ▼                           ▼
 awaiting_payment                   failed                     unknown
        │                                                          │
   PAYMENT_CONFIRMED                                    reconciliation inquires
        │                                                          │
        ▼                                    ┌─────────────┬───────┴────────┬──────────────┐
      paid                              RECONCILED_    RECONCILED_    RECONCILED_    (nothing
                                        INSTRUMENT_       PAID          FAILED        usable)
                                          LIVE             │               │             │
                                            │              ▼               ▼             ▼
                                            ▼            paid          failed      stays unknown
                                     awaiting_payment
```

`docs/state-machine.md` is generated from `payment-transition-table.ts` and CI
fails if they disagree. The database enforces the same table through a composite
foreign key, so an illegal transition is refused by PostgreSQL regardless of what
the application believes.

`expired` is deliberately not terminal: a Pix code can be paid moments after it
lapses and the money genuinely arrives.

## What paid-ness means

`captured_amount_minor` is the single source of truth. `status` and `paid_at` are
constrained to agree with it, so all three move in one statement or the row is
unwritable.

The legacy system encoded paid-ness twice and let five code paths disagree. Those
`UPDATE` statements, run verbatim against this schema, abort with
`check_violation`.

A transition into a funds-bearing state additionally requires
`evidence_class = 'authenticated_provider_read'`. Appmax webhooks carry no
signature of any kind, so a forged webhook is structurally incapable of marking a
payment paid: it can only schedule a read, and only the read can fund.

## UNKNOWN, and how it ends

A provider call that produces no usable answer yields `unknown`. It is not a
failure. The request may have reached the provider and may have created something
payable, so reporting failure would tell the merchant nothing happened when
something may well have. The API answers **202**.

The rule reconciliation keeps: **a payment leaves `unknown` only on something the
provider actually said.**

```
payment reaches unknown
      │  a trigger schedules it — no enqueue step, so it cannot be forgotten
      ▼
worker claims a batch          SELECT … FOR UPDATE SKIP LOCKED, then leases
      │                        (nothing is held while a provider is called)
      ▼
provider inquiry via readPaymentState
      │
      ├── paid, and the amount matches ──► paid       RECONCILED_PAID
      ├── instrument still live ─────────► awaiting_payment
      ├── lapsed unpaid ─────────────────► expired
      ├── positively refused ────────────► failed     RECONCILED_FAILED
      └── anything else ─────────────────► stays unknown, scheduled again
                                            with capped exponential backoff
                                            │
                                            └── after N fruitless inquiries,
                                                scheduling stops and it becomes
                                                an operator's. Still unknown,
                                                still unlocked.
```

The queue is the `payments` table itself, not a second table fed by an enqueue.
An enqueue is a dual write, and a payment that reached `unknown` by a path that
forgot to enqueue would never be reconciled — which is exactly the path already
going wrong.

### Payments abandoned mid-flight

An attempt is opened and committed in `processing` before the provider is called,
so a process that dies inside that call leaves the payment there with its claim
still open. Nothing else can move it, and while it sits there it holds both its
merchant reference and its idempotency key.

Each batch therefore sweeps first: payments in `processing` or `pending` older
than a generous threshold are moved to `unknown` and their claims released, in one
transaction. `unknown` is the honest destination — a request was sent and no
answer was recorded, so whether anything was created is exactly what nobody knows
— and it puts the payment into the machinery above.

The claim completes with what the payment now is rather than with what the caller
received, because the caller received nothing: the process handling their request
died. A retry of that key then learns the payment exists and is uncertain, instead
of being told forever that something is still being processed.

The threshold is generous on purpose. Sweeping a payment that is merely slow would
move it out from under the request still working on it.

**A lease is not a lock.** A worker that dies delays its claimed payments by one
lease and strands none.

Cases that deliberately do _not_ resolve: an attempt with no provider reference
(Appmax has no order search, so there is nothing to ask); a provider that does not
declare `pix.status`; a provider configured for the other environment; and a
provider reporting an amount other than the one expected — a Pix code carries a
fixed amount, so a disagreement means this reference is not the payment we think
it is.

See [unknown-outcome-recovery.md](unknown-outcome-recovery.md) for the operator
procedure.

## How a payment becomes paid

A payment that reaches `awaiting_payment` is live and unpaid, and something has to
notice when that changes. Two paths do, and neither is trusted alone.

```
awaiting_payment
      │
      ├── polling ─────────► the worker asks on a steady cadence
      │                      (correctness: works with no webhook at all)
      │
      └── notification ────► the provider says something happened,
                             which brings the next inquiry forward
                             (latency: it does not decide anything)
                             │
                             ▼
                    authenticated provider read
                             │
      ┌──────────────┬───────┴───────┬──────────────────┐
      ▼              ▼               ▼                  ▼
    paid          expired          failed        still awaiting
PAYMENT_        EXPIRY_         PAYMENT_        rescheduled, and the
CONFIRMED       ELAPSED         REFUSED         attempt budget untouched
```

**Polling is the correctness mechanism; notifications are a latency
optimisation.** That is forced by the provider rather than chosen: Appmax sends no
signature, and abandons delivery after four attempts. A gateway that depended on
notifications would silently lose payments; one that only polls is merely slower.

### UNKNOWN and AWAITING_PAYMENT are not the same thing

They are the two states a poll can be answering about, and collapsing them is the
mistake that matters most here.

|                                     | `unknown`                                     | `awaiting_payment`                                       |
| ----------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| What it means                       | The creation may or may not have taken effect | It took effect, and nobody has paid yet                  |
| A successful poll saying "not paid" | Reconciles to a live instrument               | Ordinary. Nothing changes                                |
| A poll that fails                   | Stays uncertain, costs an attempt             | **Stays waiting**, costs an attempt                      |
| Resolution vocabulary               | `RECONCILED_*`                                | `PAYMENT_CONFIRMED`, `EXPIRY_ELAPSED`, `PAYMENT_REFUSED` |

A polling failure never turns a waiting payment into an uncertain one. Nothing
about a failed inquiry casts doubt on whether the instrument was created — that
was already established — so manufacturing doubt would be inventing a problem.

An inquiry that succeeds and reports "not yet" does not spend the attempt budget.
That budget exists to stop asking about payments nobody can answer for, and a
provider that answered is not one of those; charging it would abandon an ordinary
unpaid Pix to an operator after a dozen correct replies.

### Expiry

Requires both halves: the instrument's own `expires_at`, passed by a grace margin,
**and** a provider read that came back and confirmed nobody paid. A timestamp
alone is a guess. The margin exists because the provider's clock is not ours, and
expiring one second early would deny a customer who paid inside the window.

A payment the provider reports as paid is never expired, whatever its deadline
says. The money arrived; a lapsed deadline does not undo that.

## Provider notifications

```
POST /v1/webhooks/appmax/<secret>        POST /v1/webhooks/cryptopay
      │  raw bytes, parsed only by these routes
      ▼
verify ──► parse ──► resolve the provider reference ──► record ──► bring the
                                                         │         inquiry forward
                                                    (unique index:
                                                   redelivery is a no-op)
```

**A notification is never evidence.** It records that a provider said something
and brings that payment's next inquiry forward; the read decides. The database
enforces this rather than the code promising it: a funded transition demands
`authenticated_provider_read`, so the endpoint could not mark a payment paid even
if it tried. The worst a forged notification achieves is one provider call the
payment would have made anyway.

**No signature is invented.** Appmax documents that its webhooks carry none, so
the receiver reports `signsNotifications: false` rather than implementing a check
that always passes — a check that always passes reads as security to everyone
after it. The endpoint is bounded instead by an unguessable path segment, which is
our own shared secret rather than a pretence at verifying the provider's. It is
compared in constant time, and a wrong secret answers exactly as an unknown path
does, so a prober learns nothing from the difference.

**CryptoPay does sign**, as a Standard Webhook: HMAC-SHA256 over
`{id}.{timestamp}.{raw body}` with a `whsec_` secret, several accepted so a
rotation can overlap, the timestamp bounded against now in both directions. A
notification that does not verify is refused before it is read. It is still not
evidence: a verified notification schedules the same authenticated read Appmax's
does, and the database still refuses to fund a payment on anything less. The
signature bounds who can cause a read; the read decides.

**Ownership comes from the provider reference**, which was recorded on an attempt
against one payment of one merchant. There is no merchant, organization or payment
id in the payload to be trusted, so a notification cannot be aimed at somebody
else's payment.

**Duplicate delivery is the norm.** At-least-once is what providers do, so a
unique index on (provider, delivery id) makes a redelivery a no-op — decided by
the database, so it holds across restarts and across processes. Where a provider
sends no delivery id, one is derived from the raw bytes.

Every legitimate notification answers `202 {"received": true}`, so a sender cannot
use the endpoint to discover which references this gateway holds.

## Payment events

```
payment reaches paid
      │  same transaction
      ▼
payment_events row  ──►  (delivery is a later milestone)
```

`payment.paid` is written in the same transaction as the money. There is no moment
at which the payment is paid and the event is not there to be delivered, so "paid,
and nobody was told" is not a state this database can hold. A refused transition
rolls back both.

It is a table rather than a broker because the delivery it exists for is one HTTP
call to another service, and a queue product would add an operational component to
avoid a problem a row already solves. `UNIQUE (payment_id, event_type)` means one
payment produces one paid event however many times the path is retried.

The payload carries the payment id, organization, merchant reference, environment,
payment method, currency, amount in minor units, paid timestamp, the customer's
phone when the merchant gave one, provider, provider reference and attempt id —
and no credential of any kind.

### Delivery

```
payment_events, pending and due
      │  claimed by lease, cross-tenant through one SECURITY DEFINER function
      ▼
POST /v1/notifications on the WhatsApp Notification Platform
      │  Idempotency-Key: the event id
      ▼
accepted ──► delivered, with the platform's identifier
retry    ──► deferred with capped exponential backoff; abandoned after a budget
refused  ──► abandoned, an operator's
no phone ──► skipped
```

The worker that reconciles payments also delivers events, by the same claiming
rule: a lease, not a lock, so a worker that dies delays its events by one lease
and strands none. The event id travels as the platform's idempotency key, so a
retry after a timeout or a restart cannot become a second message.

Nothing about delivery can reach a payment. The payment was paid before the event
was claimed, and stays paid whatever the platform answers; every outcome is
visible on `GET /v1/payments/:id`, which reports the event and its delivery state
alongside the transitions and the provider notifications. What the gateway
records is that the platform accepted the message durably; sending, pacing and
retrying towards WhatsApp are the platform's own, tracked there.

## Provider abstraction

The domain never learns a processor's vocabulary.

```
PixPaymentProvider                          CryptoPaymentProvider
  ├── createPixInstrument(request)            ├── createCryptoInstrument(request)
  └── readPaymentState(reference)             └── readPaymentState(reference)
```

A Pix instrument is a copy-and-paste code; a crypto instrument is a destination,
a payment URI and a QR code the provider rendered for whatever chain it chose.
Reading state has one shape for both, because reconciliation and the webhook
path do not care which rails a payment took. The CryptoPay adapter speaks
CryptoPay's gateway contract — a chain family, a currency, a decimal string — and
nothing above it learns what a chain id is. A crypto payment correlates on the
gateway's own payment id, which is unique forever, where a merchant reference is
free again once an earlier payment has finished.

Capabilities are declared, not assumed. A provider that does not declare
`pix.create` is never offered a Pix payment; one that does not declare
`pix.status` is reported as unable to answer rather than being called and made to
refuse. Registrations are bound to an environment, so a sandbox registration is
never used to serve a production payment.

Every provider call is classified into one taxonomy, and the taxonomy is the whole
failover story:

| Class                         | Means                                     | Licenses                     |
| ----------------------------- | ----------------------------------------- | ---------------------------- |
| `success`                     | It did what was asked                     | Continue                     |
| `safe_failure`                | Refused, and confirmed it created nothing | Try another provider         |
| `definitive_failure`          | Refused, finally                          | Fail the payment             |
| `retryable_transport_failure` | The call provably never arrived           | Try another provider         |
| `unknown_outcome`             | It may or may not have taken effect       | **Nothing.** Reconcile first |

The default for anything unmapped is `unknown_outcome`. The conservative reading
costs a reconciliation; the optimistic one costs a duplicate charge.

## Idempotency

`INSERT … ON CONFLICT DO NOTHING RETURNING` on a unique index over
`(organization_id, environment, idempotency_key)`. Concurrency is handled by the
index rather than by checking first: two simultaneous requests both reach the
insert, PostgreSQL blocks the second until the first commits, and it then sees the
conflict. An application-level "does this key exist" check could not offer that,
because another process fits between its read and its write.

The claim is **not** completed when the payment is created. The response is not
known until a provider has answered, and completing it early would let a replay
return a status and body the caller never received. Completion happens when the
payment settles.

A repeated key means one of four things: replay the stored response; the first
request is still running (`409`, retryable); the claim was never completed and has
passed its expiry (`409 idempotency_key_stranded`, not retryable); or the same key
carries a different body (`422`) — a caller bug, and answering it with the first
response would hide the mistake while charging for something they did not ask for.

## Payments and attempts

```
payment                    one merchant intent
   └── payment_attempt     one provider interaction
```

A payment attempted against two providers has two attempt rows. The provider
reference lives on the attempt, never on the payment: a single column on the
payment could hold only one of them and would silently become whichever was
written last.

An attempt is opened and committed _before_ the provider is called, so a crash
mid-flight leaves a payment in `processing` carrying an attempt with no outcome —
exactly the signal reconciliation looks for.

## Security model

| Mechanism                                                                | What becomes impossible                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Row-level security with transaction-local `app.organization_id`          | Cross-tenant reads. Isolation stops being a remembered `WHERE`. |
| `payment_gateway_application`: no ownership, no `CREATE`, no `BYPASSRLS` | A SQL-injection foothold altering the schema                    |
| Composite FK into `legal_payment_transitions`                            | Illegal transitions, whatever the application believes          |
| Deferred constraint trigger                                              | A status change committing without its audit row                |
| `transitions_into_funds_require_authenticated_read`                      | A forged webhook marking a payment paid                         |
| Append-only triggers plus `REVOKE UPDATE, DELETE`                        | Rewriting history                                               |
| `payments_status_agrees_with_capture`                                    | `status`, `paid_at` and capture disagreeing                     |
| Trigger against the organization's ceiling                               | A payment over a tenant's configured limit                      |
| CI check over `information_schema`                                       | A monetary column typed `numeric`, `real` or `money`            |

Two cross-tenant reads exist, both deliberate, both narrow, both
`SECURITY DEFINER` with a fixed `search_path`:

- `authenticate_api_key` — the organization is the _result_ of the lookup, so it
  cannot already be scoped by one.
- `claim_payments_for_reconciliation` — a worker has no tenant until it has read
  one. It returns only payments already uncertain and already due, and every write
  that follows goes through the ordinary tenant-scoped path.

API keys are hashed with a pepper held outside the database, so a dump alone does
not yield a usable key. Every authentication refusal returns the same answer:
distinguishing a revoked key from an unknown one turns the endpoint into a probe
for which keys are real.

Nothing internal leaves the process. An unhandled error is logged in full and the
caller receives the documented envelope with a request id to quote.

## Network isolation

```
internal (no route out)          outbound
  postgres                         api ────► Appmax
  redis                            worker ─► Appmax
  api, worker (also attached)
```

PostgreSQL and Redis have no route to the internet. This is the structural half of
SSRF defence for merchant-supplied URLs. Verified by asserting `postgres` cannot
resolve an external host while `api` can reach Appmax.

## Local development

```bash
cp .env.example .env          # fill in POSTGRES_PASSWORD, DATABASE_APPLICATION_PASSWORD, API_KEY_PEPPER
docker compose up -d --build  # --build matters: compose reuses completed one-shot
                              # containers, so a new migration is otherwise skipped
docker compose ps             # everything healthy
```

Issue a key for manual testing:

```bash
docker compose exec api node apps/api/dist/infrastructure/persistence/seed-api-key-cli.js
```

It prints the key once, because only its hash is stored.

## Testing

```bash
npm test                                       # unit: domain, shared, tools
npx vitest run --project api                   # unit: the api, no external services

docker compose stop worker                     # see below
docker compose --profile test run --rm test    # integration, against real PostgreSQL
```

**Integration tests need exclusive use of the database.** The reconciliation
worker claims uncertain payments across every organization — that is its job — so
a worker polling the same database will occasionally claim a payment a test just
created, and the test will not see it in its own claim. That is the worker
behaving correctly and the test being wrong to assume otherwise, so the fix is to
stop the worker rather than to weaken the assertion. CI runs no worker alongside
the tests; local development does.

Integration tests connect as two roles on purpose: the owner seeds fixtures and
inspects results, and the application role is the one under test. A test that
seeded and asserted through the same privileged connection would prove nothing
about isolation. Important invariants are attacked directly with SQL, because an
invariant only violable through our own code is not proven to be enforced by the
database.

## Appmax validation procedure

```bash
docker compose run --rm api npm run validate:appmax
```

Without credentials it exits **78** and states that nothing was validated. It does
not weaken any check to produce a pass. What has and has not been verified against
real Appmax infrastructure is recorded in [limitations.md](limitations.md).
