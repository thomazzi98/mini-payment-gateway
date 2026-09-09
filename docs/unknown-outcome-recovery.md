# Recovering from an unknown payment creation outcome

This document is for the operator holding the pager. It describes what an
`unknown` payment means, what the system has already recorded when one appears,
and how to resolve it safely.

> **Status of this document.** The evidence described here is written by code
> that exists and is covered by integration tests against real PostgreSQL. The
> automated reconciliation loop that would consume that evidence **is not built
> yet**. Until it is, every procedure below is manual. This is stated plainly
> rather than implied, because the difference matters when something is wrong at
> 3am.

## What `unknown` means

A payment is `unknown` when the gateway sent a request to a provider and cannot
determine whether it took effect.

It does **not** mean the payment failed. It means the opposite of knowing: the
request may have reached the provider, and the provider may have created
something a customer can pay. Recording it as `failed` would be a claim we cannot
support, and it is how a merchant comes to believe nothing happened while a live
QR code sits in a customer's banking app.

For Appmax specifically, this state is unavoidable rather than a design choice:

- `POST /v1/orders` accepts no merchant-supplied reference.
- There is no order search or list endpoint.

So after a timeout on order creation, there is no question we can ask Appmax that
means "did the order I just tried to create get created?"

## Why this is survivable

The two risky calls sit on different axes, and that is what makes the state
recoverable rather than merely regrettable:

| Call                    | Recoverable after a timeout?           | Can money move against it?                           |
| ----------------------- | -------------------------------------- | ---------------------------------------------------- |
| `POST /v1/customers`    | Yes — it is an upsert on a natural key | No                                                   |
| `POST /v1/orders`       | **No** — no reference, no search       | **No.** A bare order with no Pix instrument is inert |
| `POST /v1/payments/pix` | **Yes** — via `GET /v1/orders/{id}`    | **Yes** — this is the live one                       |

The feared combination, _unrecoverable **and** financially live_, never occurs.
An orphaned order costs nothing and no customer can pay it. The only live
artefact is the Pix instrument, and that one can be read back.

This yields the governing invariant:

> **At most one payable instrument is ever presented per payment.**

Which is why the use case never retries or fails over after an unknown outcome.
Retrying is precisely how a customer ends up holding two payable codes for one
order.

## What is already recorded when an unknown outcome happens

By the time you are looking at the payment, the following is durable. None of it
depends on the process that was handling the request surviving.

1. **The payment row**, in status `unknown`.
2. **A payment attempt**, carrying `provider_code`, `outcome_class =
'unknown_outcome'`, the `failure_reason`, and — when the provider got far
   enough to name something — a `provider_reference`.
3. **Status transitions**, one per move, each naming the attempt that caused it
   and the evidence class behind it. The history is append-only: it cannot be
   rewritten or deleted, including by the application role.
4. **The idempotency record**, completed with the exact status and body the
   caller received (`202`, not `201` — see below).

The transition into `unknown` carries evidence class `internal`, which is
deliberate and load-bearing. Only `authenticated_provider_read` evidence may move
a payment into a funds-bearing state, so an uncertain payment can never become
`paid` without someone actually reading the provider.

## Finding payments that need attention

Connect as the owner role. Payments stuck in `unknown` are the backlog:

```sql
SELECT p.public_id,
       p.organization_id,
       p.environment,
       p.expected_amount_minor,
       p.currency,
       p.merchant_reference,
       p.created_at,
       a.provider_code,
       a.provider_reference,
       a.failure_reason
  FROM payments p
  JOIN payment_attempts a ON a.payment_id = p.id
 WHERE p.status = 'unknown'
 ORDER BY p.created_at;
```

Two cases fall out, and they are handled differently:

- **`provider_reference IS NOT NULL`** — the provider named something. This is
  the cheap case: read it back.
- **`provider_reference IS NULL`** — the request may never have been delivered,
  or the response was unreadable. This is the expensive case.

The full history of one payment:

```sql
SELECT sequence_number, from_status, to_status, trigger_name,
       evidence_class, reason, occurred_at
  FROM payment_status_transitions
 WHERE payment_id = (SELECT id FROM payments WHERE public_id = $1)
 ORDER BY sequence_number;
```

## Resolving one payment

### When a provider reference exists

Read the authoritative state with `GET /v1/orders/{provider_reference}`. The
Appmax adapter already implements this as `readPaymentState`, so it maps the
provider's own status vocabulary into the gateway's.

What you find determines the transition, all of which are declared legal out of
`unknown`:

| What the provider reports    | Move to            | Trigger                      | Evidence required             |
| ---------------------------- | ------------------ | ---------------------------- | ----------------------------- |
| A live Pix instrument exists | `awaiting_payment` | `RECONCILED_INSTRUMENT_LIVE` | `authenticated_provider_read` |
| Nothing was created          | `pending`          | `RECONCILED_NOT_CREATED`     | `authenticated_provider_read` |
| Already paid                 | `paid`             | `RECONCILED_PAID`            | `authenticated_provider_read` |
| Expired unpaid               | `expired`          | `RECONCILED_EXPIRED`         | `authenticated_provider_read` |

Only `pending` permits another provider attempt. That is the point of
distinguishing it: it is the one answer that proves no payable artefact exists.

### When no provider reference exists

There is nothing to read back, so the order cannot be located by API. Before
doing anything else, establish whether the customer was ever shown a code. The
gateway records "an instrument was presented" as a fact rather than an
assumption, so this is answerable rather than a guess.

If no instrument was ever presented, the orphaned Appmax order is inert: nobody
can pay it, and it costs nothing to abandon. The payment may move to `pending`
and be attempted again.

If you cannot establish that, do **not** attempt again. Escalate. Creating a
second instrument is the one genuinely irreversible mistake available here.

### Last resort

```
unknown -> failed   RESOLUTION_EXHAUSTED   evidence: operator
```

This edge requires `operator` evidence precisely so that it cannot be reached
automatically. It is an admission that the question was never answered, and it
should be rare enough to be worth investigating each time.

## What the merchant sees meanwhile

An unknown outcome answers **HTTP 202**, not an error:

- The payment exists and is addressable.
- The status is reported honestly as `unknown`.
- No instrument is included, because none can be shown safely.

A `4xx` or `5xx` would tell the merchant nothing happened, when something may
well have. 202 says "accepted, not yet resolved", which is the truth.

The idempotency record stores that same `202` and body, so a merchant retrying
with the same key receives what they received the first time rather than a
fabricated success.

## Known gaps

Stated plainly, because a recovery document that overstates the machinery is
worse than none.

1. **There is no reconciliation worker.** `readPaymentState` is implemented and
   the evidence needed to drive it is recorded, but nothing schedules it. Every
   procedure above is currently manual, and no payment resolves itself.
2. **A claim stranded by a crash blocks its key indefinitely.** If the process
   dies between opening the attempt and applying the outcome, the idempotency
   record stays `in_flight`. `idempotency_records` carries an `expires_at` (24
   hours) and an index on it, but the claim path does not consult it and nothing
   sweeps expired rows, so a merchant retrying that key receives `409
idempotency_key_in_flight` forever rather than for 24 hours. The payment
   itself is intact and recoverable by the procedures above; it is the _retry_
   that is blocked.
3. **Expiry is not driven from the provider's own `expires_at`.** Nothing yet
   expires an `awaiting_payment` payment whose instrument has lapsed.
