# Architecture

How this gateway is put together, and why. Where a decision has a cost, the cost
is named rather than left for the reader to discover.

## Shape

```
merchant
   │  POST /v1/payments, Idempotency-Key, API key
   ▼
api (Fastify)
   │  authenticate → validate → one use case
   ▼
application            provider registry ──► Appmax adapter ──► Appmax
   │                                               ▲
   ▼                                               │
PostgreSQL  ◄──── reconciliation worker ───────────┘
```

Two processes, one image, one database:

- **api** serves HTTP.
- **worker** resolves payments whose outcome was never determined.

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

## Provider abstraction

The domain never learns a processor's vocabulary.

```
PixPaymentProvider
  ├── createPixInstrument(request) → ProviderResult<PixInstrument>
  └── readPaymentState(reference)  → ProviderResult<ObservedPaymentState>
```

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
docker compose --profile test run --rm test    # integration, against real PostgreSQL
```

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
