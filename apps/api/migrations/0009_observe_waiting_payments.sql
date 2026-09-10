-- Observing payments that are simply waiting to be paid.
--
-- Reconciliation looked only at `unknown`, so a payment that reached
-- `awaiting_payment` normally and was then paid by the customer was observed by
-- nothing. Creating payments worked; confirming them did not.
--
-- The queue stays the payments table and the scheduling stays derived from
-- status, exactly as it is for `unknown`. What changes is which statuses are
-- scheduled, and that the claim reports which status a payment was claimed from,
-- because the two are resolved by different vocabulary and must not be confused.

-- A live order can be positively refused. Appmax reports `recusado_por_risco`,
-- which the adapter already maps to `failed`, and until now that observation had
-- nowhere legal to go: the only edges out of `awaiting_payment` were to paid,
-- expired, cancelled and unknown.
INSERT INTO legal_payment_transitions (from_status, to_status, trigger_name, minimum_evidence)
VALUES ('awaiting_payment', 'failed', 'PAYMENT_REFUSED', 'authenticated_provider_read');

-- Scheduling now covers both observable statuses. Attempts reset on entry,
-- because a payment that has just changed status deserves a fresh budget.
CREATE OR REPLACE FUNCTION schedule_reconciliation_with_status() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  is_observable_now  BOOLEAN := NEW.status IN ('unknown', 'awaiting_payment');
  was_observable     BOOLEAN := TG_OP = 'UPDATE' AND OLD.status IN ('unknown', 'awaiting_payment');
BEGIN
  IF is_observable_now AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    NEW.reconciliation_due_at := now();
    NEW.reconciliation_attempts := 0;
  ELSIF NOT is_observable_now AND was_observable THEN
    NEW.reconciliation_due_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP INDEX IF EXISTS payments_reconciliation_due;
CREATE INDEX payments_reconciliation_due
  ON payments (reconciliation_due_at)
  WHERE status IN ('unknown', 'awaiting_payment') AND reconciliation_due_at IS NOT NULL;

-- Payments already sitting in `awaiting_payment` were created before anything
-- scheduled them. Without this they would stay unobserved forever, which is the
-- defect this migration exists to close.
UPDATE payments
   SET reconciliation_due_at = now()
 WHERE status = 'awaiting_payment' AND reconciliation_due_at IS NULL;

DROP FUNCTION IF EXISTS claim_payments_for_reconciliation(INT, INT);

-- Returns the status it claimed from, and the instrument's own expiry.
--
-- The status matters because `unknown` and `awaiting_payment` mean different
-- things and resolve through different triggers: one is uncertainty about whether
-- an operation happened, the other is certainty that it did and that nobody has
-- paid yet. Collapsing them would let a polling failure turn a perfectly healthy
-- unpaid payment into an uncertain one.
CREATE FUNCTION claim_payments_for_reconciliation(claim_limit INT, lease_seconds INT)
RETURNS TABLE (
  id                      UUID,
  organization_id         UUID,
  environment             environment,
  status                  TEXT,
  expected_amount_minor   BIGINT,
  currency                currency_code,
  expires_at              TIMESTAMPTZ,
  reconciliation_attempts INTEGER,
  provider_code           TEXT,
  provider_reference      TEXT,
  attempt_id              UUID
)
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  WITH due AS (
    SELECT payments.id FROM payments
     WHERE payments.status IN ('unknown', 'awaiting_payment')
       AND payments.reconciliation_due_at IS NOT NULL
       AND payments.reconciliation_due_at <= now()
     ORDER BY payments.reconciliation_due_at
     FOR UPDATE SKIP LOCKED
     LIMIT claim_limit
  ), leased AS (
    UPDATE payments
       SET reconciliation_due_at = now() + make_interval(secs => lease_seconds),
           reconciliation_attempts = payments.reconciliation_attempts + 1
     WHERE payments.id IN (SELECT due.id FROM due)
    RETURNING payments.id, payments.organization_id, payments.environment, payments.status,
              payments.expected_amount_minor, payments.currency, payments.expires_at,
              payments.reconciliation_attempts
  )
  SELECT leased.id, leased.organization_id, leased.environment, leased.status,
         leased.expected_amount_minor, leased.currency, leased.expires_at,
         leased.reconciliation_attempts,
         attempt.provider_code, attempt.provider_reference, attempt.id
    FROM leased
    LEFT JOIN LATERAL (
      SELECT payment_attempts.id, payment_attempts.provider_code,
             payment_attempts.provider_reference
        FROM payment_attempts
       WHERE payment_attempts.payment_id = leased.id
       ORDER BY payment_attempts.attempt_number DESC
       LIMIT 1
    ) AS attempt ON TRUE;
$$;

-- The operator backlog covers both statuses for the same reason.
CREATE OR REPLACE FUNCTION count_payments_awaiting_operator()
RETURNS BIGINT
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*) FROM payments
   WHERE payments.status IN ('unknown', 'awaiting_payment')
     AND payments.reconciliation_due_at IS NULL;
$$;

-- ===================================================================
-- Inbound provider events.
--
-- Appmax sends no signature of any kind, which is documented by Appmax itself and
-- is why a funds transition demands an authenticated read. An event here is
-- therefore never evidence. It is a prompt: it records that something was said,
-- and brings the payment's next inquiry forward. The inquiry decides.
--
-- Stored rather than acted on inline because Appmax expects an answer within five
-- seconds and abandons delivery after four attempts. Persisting and returning is
-- fast and loses nothing.
-- ===================================================================
CREATE TABLE provider_webhook_events (
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  provider_code     TEXT NOT NULL,
  -- The provider's own identifier for this delivery. Duplicate delivery is normal
  -- and expected, so the unique index is what makes it a no-op rather than a
  -- second transition.
  provider_event_id TEXT NOT NULL CHECK (length(btrim(provider_event_id)) BETWEEN 1 AND 255),
  event_type        TEXT NOT NULL CHECK (length(btrim(event_type)) BETWEEN 1 AND 100),
  -- Present when the event named an order we could resolve to a payment. Absent
  -- events are still recorded: an event about something we do not recognise is
  -- worth keeping and worth not acting on.
  payment_id        UUID REFERENCES payments (id) ON DELETE SET NULL,
  provider_reference TEXT,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- What was done about it, for the operator reading back later.
  disposition       TEXT NOT NULL CHECK (disposition IN (
    'scheduled_read', 'duplicate', 'unmatched', 'ignored'
  )),

  CONSTRAINT provider_webhook_events_unique_delivery
    UNIQUE (provider_code, provider_event_id)
);

CREATE INDEX provider_webhook_events_payment ON provider_webhook_events (payment_id, received_at DESC);

-- History, not state. Nothing may rewrite what a provider told us.
CREATE TRIGGER provider_webhook_events_append_only
  BEFORE UPDATE OR DELETE ON provider_webhook_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ===================================================================
-- The payment event outbox.
--
-- A payment that commits as paid and then fails to publish its event is a payment
-- nobody downstream ever hears about. Writing the event in the same transaction
-- as the transition makes that impossible: either both are there or neither is.
--
-- Deliberately a table and not a broker. The delivery this exists for is one HTTP
-- call to another service, and a queue product would add an operational component
-- to avoid a problem a row already solves.
-- ===================================================================
CREATE TABLE payment_events (
  id               UUID PRIMARY KEY DEFAULT uuidv7(),
  payment_id       UUID NOT NULL,
  organization_id  UUID NOT NULL,
  event_type       TEXT NOT NULL CHECK (event_type IN ('payment.paid')),
  -- The event body, already in the shape a consumer receives. Built at write time
  -- so a consumer reads what was true when it happened, not what the payment
  -- looks like now.
  payload          JSONB NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Delivery bookkeeping. Nothing consumes this yet; the guarantee being
  -- established now is that the event exists, not that anything has read it.
  published_at     TIMESTAMPTZ,
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payment_events_belong_to_one_tenant
    FOREIGN KEY (payment_id, organization_id) REFERENCES payments (id, organization_id)
    ON DELETE CASCADE,

  -- One payment becomes paid once. A second `payment.paid` for the same payment
  -- would be a duplicate charge notification downstream, so it is refused here
  -- rather than deduplicated by every future consumer.
  CONSTRAINT payment_events_one_paid_per_payment UNIQUE (payment_id, event_type)
);

CREATE INDEX payment_events_unpublished
  ON payment_events (next_attempt_at)
  WHERE published_at IS NULL;

ALTER TABLE provider_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events          ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_events_tenant_isolation ON payment_events
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- Webhook events arrive before any tenant is known, so they are resolved rather
-- than scoped. The policy exists so the table is not readable wholesale by the
-- application role once a scope is set.
CREATE POLICY provider_webhook_events_scoped ON provider_webhook_events
  USING (
    payment_id IS NULL
    OR EXISTS (
      SELECT 1 FROM payments
       WHERE payments.id = provider_webhook_events.payment_id
         AND payments.organization_id = current_organization_id()
    )
  );

INSERT INTO tenant_scoped_tables (table_name) VALUES ('payment_events');
