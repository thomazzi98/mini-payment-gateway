-- Payments abandoned mid-flight must reach the one state that describes them.
--
-- openAttempt commits `processing` before the provider is called, and its own
-- comment claims that a crash there "leaves a payment in processing carrying an
-- attempt with no outcome, which is exactly the signal reconciliation needs".
-- Reconciliation never looked at that signal: it scans `unknown` only. So a
-- process that died inside the provider call left the payment in `processing`
-- and its idempotency claim `in_flight` with nothing able to move either, which
-- held the key and the merchant reference permanently.
--
-- `pending` has the same shape after a safe failure, where the request is not
-- complete and the claim is deliberately left open for the next attempt.
--
-- The honest destination is `unknown`. A request was sent and no answer was
-- recorded, so whether anything was created is exactly what nobody knows — which
-- is what `unknown` means, and what reconciliation already resolves.

CREATE FUNCTION find_stranded_payments(older_than_seconds INT, claim_limit INT)
RETURNS TABLE (
  id               UUID,
  organization_id  UUID,
  public_id        public_identifier,
  environment      environment,
  status           TEXT,
  currency         currency_code,
  expected_amount_minor BIGINT,
  merchant_reference    TEXT,
  idempotency_key       TEXT
)
  LANGUAGE sql
  STABLE
  -- Cross-tenant for the same reason reconciliation's claim is: a sweeper has no
  -- tenant to scope itself to until it has read one. It returns only payments
  -- already stuck, cannot be steered at a tenant, and every write that follows
  -- goes through the ordinary tenant-scoped path.
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT payments.id, payments.organization_id, payments.public_id, payments.environment,
         payments.status, payments.currency, payments.expected_amount_minor,
         payments.merchant_reference, records.idempotency_key
    FROM payments
    LEFT JOIN idempotency_records AS records ON records.payment_id = payments.id
   WHERE payments.status IN ('processing', 'pending')
     -- Generous, because a payment that is merely slow must never be swept out
     -- from under the request still working on it.
     AND payments.updated_at < now() - make_interval(secs => older_than_seconds)
   ORDER BY payments.updated_at
   LIMIT claim_limit;
$$;
