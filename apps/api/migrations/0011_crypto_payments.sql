-- Crypto as a payment method.
--
-- A crypto provider issues a destination rather than a Pix code, names an asset
-- rather than a fiat currency, and confirms a payment on chain evidence rather
-- than on a bank's word. None of that changes the lifecycle: the payment still
-- becomes paid only on an authenticated read of the provider, still through the
-- same transition table, still with its event written in the same transaction.
-- What changes is vocabulary, and this migration widens it.

-- An asset code is a currency code that may be longer than three letters. USDC
-- is four. The domain keeps the shape check the fiat one had, so a lowercase or
-- decorated code is still refused at the column.
CREATE DOMAIN asset_code AS TEXT CHECK (VALUE ~ '^[A-Z]{3,5}$');

-- Both functions return the column by its old domain, and a SQL function whose
-- declared row type no longer matches what its body selects fails at call time.
-- Dropped here and recreated below, unchanged except for the type.
DROP FUNCTION claim_payments_for_reconciliation(INT, INT);
DROP FUNCTION find_stranded_payments(INT, INT);

ALTER TABLE payments
  ALTER COLUMN currency TYPE asset_code USING btrim(currency)::TEXT;

DROP DOMAIN currency_code;

ALTER TABLE payments DROP CONSTRAINT payments_payment_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check
  CHECK (payment_method IN ('pix', 'crypto', 'card', 'boleto'));

-- Where the customer is told the payment went through. On the payment rather
-- than the event because the event is built from the payment row alone, and
-- optional because the crypto rails need nothing about the payer.
ALTER TABLE payments
  ADD COLUMN customer_phone TEXT CHECK (customer_phone ~ '^\+[1-9][0-9]{7,14}$');

-- What the customer was shown, on the attempt that issued it. The provider
-- reference already lives here for the same reason: a payment tried against two
-- providers has two of each, and a column on the payment could hold only one.
ALTER TABLE payment_attempts ADD COLUMN instrument JSONB;

CREATE FUNCTION claim_payments_for_reconciliation(claim_limit INT, lease_seconds INT)
RETURNS TABLE (
  id                      UUID,
  organization_id         UUID,
  environment             environment,
  status                  TEXT,
  expected_amount_minor   BIGINT,
  currency                asset_code,
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

CREATE FUNCTION find_stranded_payments(older_than_seconds INT, claim_limit INT)
RETURNS TABLE (
  id               UUID,
  organization_id  UUID,
  public_id        public_identifier,
  environment      environment,
  status           TEXT,
  currency         asset_code,
  expected_amount_minor BIGINT,
  merchant_reference    TEXT,
  idempotency_key       TEXT
)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT payments.id, payments.organization_id, payments.public_id, payments.environment,
         payments.status, payments.currency, payments.expected_amount_minor,
         payments.merchant_reference, records.idempotency_key
    FROM payments
    LEFT JOIN idempotency_records AS records ON records.payment_id = payments.id
   WHERE payments.status IN ('processing', 'pending')
     AND payments.updated_at < now() - make_interval(secs => older_than_seconds)
   ORDER BY payments.updated_at
   LIMIT claim_limit;
$$;
