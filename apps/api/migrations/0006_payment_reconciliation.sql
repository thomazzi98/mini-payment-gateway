-- Resolving payments whose outcome was never determined.
--
-- A payment reaches `unknown` when a provider call produced no usable answer. It
-- is the one non-terminal state nothing can leave on its own, so without a
-- mechanism to revisit it, `unknown` is where payments go to be forgotten.
--
-- The work queue is the payments table itself rather than a second table fed by
-- an enqueue step. An enqueue is a dual write: a payment that reached `unknown`
-- by a path that forgot to enqueue would never be reconciled, and that path is
-- exactly the one that is going wrong already. Deriving the queue from the
-- authoritative status makes "unknown but unscheduled" impossible to create by
-- omission.

-- An authoritative provider read may now close a payment as failed. Previously
-- the only edge out of `unknown` to `failed` required an operator, so a provider
-- that positively reported a refusal had nowhere to put it and the payment stayed
-- uncertain forever.
INSERT INTO legal_payment_transitions (from_status, to_status, trigger_name, minimum_evidence)
VALUES ('unknown', 'failed', 'RECONCILED_FAILED', 'authenticated_provider_read');

ALTER TABLE payments
  -- When this payment should next be inquired about. NULL means it is not
  -- scheduled: either it is resolved, or reconciliation gave up and an operator
  -- owns it. It is never a lock, so nothing can be stranded by holding one.
  ADD COLUMN reconciliation_due_at   TIMESTAMPTZ,
  ADD COLUMN reconciliation_attempts INTEGER NOT NULL DEFAULT 0
                                     CHECK (reconciliation_attempts >= 0),
  -- The last thing the provider or the transport actually said. Diagnostic only;
  -- nothing branches on it.
  ADD COLUMN reconciliation_note     TEXT;

-- Scheduling follows status rather than being maintained alongside it, so a
-- payment that becomes uncertain is discoverable even if the code that moved it
-- knew nothing about reconciliation.
CREATE OR REPLACE FUNCTION schedule_reconciliation_with_status() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'unknown' AND OLD.status IS DISTINCT FROM 'unknown' THEN
    NEW.reconciliation_due_at := now();
    NEW.reconciliation_attempts := 0;
  ELSIF NEW.status <> 'unknown' AND OLD.status = 'unknown' THEN
    NEW.reconciliation_due_at := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payments_schedule_reconciliation
  BEFORE UPDATE OF status ON payments
  FOR EACH ROW EXECUTE FUNCTION schedule_reconciliation_with_status();

-- The worker's only read path. Partial, because the scheduled set is a tiny
-- fraction of all payments and stays small if reconciliation is working.
CREATE INDEX payments_reconciliation_due
  ON payments (reconciliation_due_at)
  WHERE status = 'unknown' AND reconciliation_due_at IS NOT NULL;

-- Reconciliation is inherently cross-tenant: one worker resolves payments for
-- every organization, and it has no tenant to scope itself to until it has read
-- one. That is the same shape as authenticating an API key, and it is handled the
-- same way — one narrow SECURITY DEFINER function rather than a role that can
-- bypass row level security generally.
--
-- The surface is deliberately small. It returns only payments already in
-- `unknown` and already due, only the columns an inquiry needs, and it cannot be
-- steered at a particular tenant or payment. Everything it hands back is then
-- written through the ordinary tenant-scoped path, so the relaxation covers the
-- discovery step and nothing else.
CREATE FUNCTION claim_payments_for_reconciliation(claim_limit INT, lease_seconds INT)
RETURNS TABLE (
  id                      UUID,
  organization_id         UUID,
  environment             environment,
  expected_amount_minor   BIGINT,
  currency                currency_code,
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
     WHERE payments.status = 'unknown'
       AND payments.reconciliation_due_at IS NOT NULL
       AND payments.reconciliation_due_at <= now()
     ORDER BY payments.reconciliation_due_at
     -- SKIP LOCKED is what makes several workers safe: a row another worker is
     -- claiming is passed over rather than waited for.
     FOR UPDATE SKIP LOCKED
     LIMIT claim_limit
  ), leased AS (
    UPDATE payments
       SET reconciliation_due_at = now() + make_interval(secs => lease_seconds),
           reconciliation_attempts = payments.reconciliation_attempts + 1
     WHERE payments.id IN (SELECT due.id FROM due)
    RETURNING payments.id, payments.organization_id, payments.environment,
              payments.expected_amount_minor, payments.currency,
              payments.reconciliation_attempts
  )
  SELECT leased.id, leased.organization_id, leased.environment,
         leased.expected_amount_minor, leased.currency, leased.reconciliation_attempts,
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

-- How many uncertain payments reconciliation has stopped scheduling. This is the
-- operator backlog, and a number worth watching: if it grows, inquiries are
-- failing for a reason nobody has looked at.
CREATE FUNCTION count_payments_awaiting_operator()
RETURNS BIGINT
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*) FROM payments
   WHERE payments.status = 'unknown' AND payments.reconciliation_due_at IS NULL;
$$;
