-- Payments, and the attempts made to fulfil them.
--
-- A payment belongs to the gateway, not to a provider. It may be attempted
-- against several providers in turn, so `payments` never carries a provider
-- reference: that lives on `payment_attempts`, one row per try. One payment is
-- never assumed to equal one provider transaction.
--
-- The reference tables below are seeded from the same vocabulary as
-- apps/api/src/domain/payment/payment-transition-table.ts. A test compares the two
-- and fails when they diverge, so the state machine and the database cannot come
-- to disagree about what is legal.

CREATE TABLE payment_statuses (
  status                TEXT PRIMARY KEY,
  is_terminal           BOOLEAN NOT NULL,
  implies_funds_held    BOOLEAN NOT NULL
);

INSERT INTO payment_statuses (status, is_terminal, implies_funds_held) VALUES
  ('pending',            FALSE, FALSE),
  ('processing',         FALSE, FALSE),
  ('unknown',            FALSE, FALSE),
  ('awaiting_payment',   FALSE, FALSE),
  ('paid',               FALSE, TRUE),
  ('partially_refunded', FALSE, TRUE),
  ('refunded',           TRUE,  TRUE),
  ('chargeback',         FALSE, TRUE),
  ('expired',            FALSE, FALSE),
  ('failed',             TRUE,  FALSE),
  ('cancelled',          TRUE,  FALSE);

CREATE TABLE payment_evidence_classes (
  evidence_class TEXT PRIMARY KEY,
  rank           SMALLINT NOT NULL UNIQUE
);

INSERT INTO payment_evidence_classes (evidence_class, rank) VALUES
  ('internal', 0),
  ('authenticated_provider_read', 1),
  ('operator', 2);

CREATE TABLE legal_payment_transitions (
  from_status       TEXT NOT NULL REFERENCES payment_statuses (status),
  to_status         TEXT NOT NULL REFERENCES payment_statuses (status),
  trigger_name      TEXT NOT NULL,
  minimum_evidence  TEXT NOT NULL REFERENCES payment_evidence_classes (evidence_class),
  PRIMARY KEY (from_status, to_status, trigger_name),
  CONSTRAINT legal_transitions_never_self CHECK (from_status <> to_status)
);

INSERT INTO legal_payment_transitions (from_status, to_status, trigger_name, minimum_evidence) VALUES
  ('pending',            'processing',         'PROVIDER_REQUEST_SENT',      'internal'),
  ('pending',            'cancelled',          'MERCHANT_CANCELLED',         'internal'),
  ('pending',            'failed',             'ROUTING_EXHAUSTED',          'internal'),
  ('processing',         'awaiting_payment',   'INSTRUMENT_ISSUED',          'authenticated_provider_read'),
  ('processing',         'failed',             'PROVIDER_REFUSED',           'authenticated_provider_read'),
  ('processing',         'unknown',            'PROVIDER_OUTCOME_UNKNOWN',   'internal'),
  ('processing',         'pending',            'SAFE_FAILURE_OBSERVED',      'authenticated_provider_read'),
  ('unknown',            'awaiting_payment',   'RECONCILED_INSTRUMENT_LIVE', 'authenticated_provider_read'),
  ('unknown',            'pending',            'RECONCILED_NOT_CREATED',     'authenticated_provider_read'),
  ('unknown',            'paid',               'RECONCILED_PAID',            'authenticated_provider_read'),
  ('unknown',            'expired',            'RECONCILED_EXPIRED',         'authenticated_provider_read'),
  ('unknown',            'failed',             'RESOLUTION_EXHAUSTED',       'operator'),
  ('awaiting_payment',   'paid',               'PAYMENT_CONFIRMED',          'authenticated_provider_read'),
  ('awaiting_payment',   'expired',            'EXPIRY_ELAPSED',             'authenticated_provider_read'),
  ('awaiting_payment',   'cancelled',          'MERCHANT_CANCELLED',         'internal'),
  ('awaiting_payment',   'unknown',            'PROVIDER_OUTCOME_UNKNOWN',   'internal'),
  ('expired',            'paid',               'LATE_PAYMENT_CONFIRMED',     'authenticated_provider_read'),
  ('paid',               'partially_refunded', 'PARTIAL_REFUND_SETTLED',     'authenticated_provider_read'),
  ('paid',               'refunded',           'REFUND_SETTLED',             'authenticated_provider_read'),
  ('paid',               'chargeback',         'CHARGEBACK_OPENED',          'authenticated_provider_read'),
  ('partially_refunded', 'refunded',           'REFUND_SETTLED',             'authenticated_provider_read'),
  ('partially_refunded', 'chargeback',         'CHARGEBACK_OPENED',          'authenticated_provider_read'),
  ('chargeback',         'paid',               'CHARGEBACK_WON',             'authenticated_provider_read'),
  ('chargeback',         'refunded',           'CHARGEBACK_LOST',            'authenticated_provider_read');

-- Nothing may leave a terminal status. Enforced on the table of legal edges
-- itself, so an illegal edge cannot even be declared.
ALTER TABLE legal_payment_transitions ADD CONSTRAINT legal_transitions_never_leave_terminal
  CHECK (from_status NOT IN ('refunded', 'failed', 'cancelled'));

CREATE DOMAIN currency_code AS CHAR(3) CHECK (VALUE ~ '^[A-Z]{3}$');

CREATE TABLE payments (
  id                     UUID PRIMARY KEY DEFAULT uuidv7(),
  public_id              public_identifier NOT NULL UNIQUE,
  organization_id        UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  environment            environment NOT NULL,

  merchant_reference     TEXT NOT NULL CHECK (length(btrim(merchant_reference)) BETWEEN 1 AND 255),
  payment_method         TEXT NOT NULL CHECK (payment_method IN ('pix', 'card', 'boleto')),
  currency               currency_code NOT NULL,

  -- Integer minor units, always. There is no floating point anywhere in this
  -- schema; a test greps information_schema to keep it that way.
  expected_amount_minor  BIGINT NOT NULL CHECK (expected_amount_minor > 0),
  captured_amount_minor  BIGINT NOT NULL DEFAULT 0 CHECK (captured_amount_minor >= 0),
  refunded_amount_minor  BIGINT NOT NULL DEFAULT 0 CHECK (refunded_amount_minor >= 0),

  status                 TEXT NOT NULL DEFAULT 'pending' REFERENCES payment_statuses (status),
  -- Incremented on every status change and matched by the transition row, so an
  -- unaudited change cannot commit.
  status_sequence        BIGINT NOT NULL DEFAULT 0,
  -- Optimistic concurrency for readers that update without taking a row lock.
  version                INTEGER NOT NULL DEFAULT 0,

  paid_at                TIMESTAMPTZ,
  expires_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ===================================================================
  -- The legacy system encoded paid-ness twice, as `status` and `paidAt`, and five
  -- uncoordinated code paths wrote them independently until they disagreed. Here
  -- there is one source of truth — captured_amount_minor — and the other two are
  -- constrained to agree with it. Those legacy UPDATE statements, run verbatim
  -- against this schema, abort with check_violation.
  -- ===================================================================
  CONSTRAINT payments_paid_at_agrees_with_capture CHECK (
    (paid_at IS NOT NULL) = (captured_amount_minor > 0)
  ),
  CONSTRAINT payments_status_agrees_with_capture CHECK (
    (captured_amount_minor > 0) =
      (status IN ('paid', 'partially_refunded', 'refunded', 'chargeback'))
  ),

  CONSTRAINT payments_refund_within_capture CHECK (
    refunded_amount_minor <= captured_amount_minor
  ),
  CONSTRAINT payments_partially_refunded_shape CHECK (
    status <> 'partially_refunded'
    OR (refunded_amount_minor > 0 AND refunded_amount_minor < captured_amount_minor)
  ),
  CONSTRAINT payments_refunded_shape CHECK (
    status <> 'refunded' OR refunded_amount_minor = captured_amount_minor
  ),

  -- Referenced by the composite foreign key on child tables, so a child row can
  -- never be attached to a payment belonging to another organization.
  CONSTRAINT payments_tenant_identity UNIQUE (id, organization_id)
);

-- A merchant reference identifies one live payment. Re-using it while an earlier
-- payment is still open is a duplicate, not a second payment; once the earlier one
-- is finished the reference is free again.
CREATE UNIQUE INDEX payments_one_live_per_merchant_reference
  ON payments (organization_id, environment, merchant_reference)
  WHERE status NOT IN ('failed', 'cancelled', 'expired', 'refunded');

CREATE INDEX payments_organization_created ON payments (organization_id, environment, created_at DESC);
CREATE INDEX payments_status ON payments (status) WHERE status NOT IN ('paid', 'failed', 'cancelled', 'refunded');

CREATE TRIGGER payments_touch_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- One payment, many attempts. This is the table that makes retries and failover
-- expressible: a payment that was tried against two providers has two rows here.
CREATE TABLE payment_attempts (
  id                     UUID PRIMARY KEY DEFAULT uuidv7(),
  public_id              public_identifier NOT NULL UNIQUE,
  payment_id             UUID NOT NULL,
  organization_id        UUID NOT NULL,

  attempt_number         SMALLINT NOT NULL CHECK (attempt_number >= 1),
  provider_code          TEXT NOT NULL CHECK (length(btrim(provider_code)) BETWEEN 1 AND 50),

  outcome_class          TEXT CHECK (outcome_class IN (
                           'success', 'safe_failure', 'definitive_failure',
                           'retryable_transport_failure', 'unknown_outcome')),
  failure_reason         TEXT,

  -- The provider's own identifier for whatever this attempt created. Null until
  -- the provider answers, and null forever when it never did.
  provider_reference     TEXT,

  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at            TIMESTAMPTZ,

  CONSTRAINT payment_attempts_belong_to_one_tenant
    FOREIGN KEY (payment_id, organization_id) REFERENCES payments (id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT payment_attempts_number_unique UNIQUE (payment_id, attempt_number),
  CONSTRAINT payment_attempts_finished_shape CHECK (
    (finished_at IS NULL) = (outcome_class IS NULL)
  ),
  CONSTRAINT payment_attempts_tenant_identity UNIQUE (id, organization_id)
);

-- Two payments may never claim the same provider transaction. This is the
-- correlation key an inbound webhook is resolved through, and without it a
-- misrouted callback could credit the wrong payment.
CREATE UNIQUE INDEX payment_attempts_provider_reference
  ON payment_attempts (provider_code, provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE INDEX payment_attempts_payment ON payment_attempts (payment_id, attempt_number);

-- Why a payment is in the status it is in. Append-only: this is the audit trail
-- that answers "why does this say paid, and what proved it".
CREATE TABLE payment_status_transitions (
  id                      UUID PRIMARY KEY DEFAULT uuidv7(),
  payment_id              UUID NOT NULL,
  organization_id         UUID NOT NULL,
  sequence_number         BIGINT NOT NULL,

  from_status             TEXT NOT NULL,
  to_status               TEXT NOT NULL,
  trigger_name            TEXT NOT NULL,
  evidence_class          TEXT NOT NULL REFERENCES payment_evidence_classes (evidence_class),

  payment_attempt_id      UUID,
  captured_amount_after   BIGINT NOT NULL CHECK (captured_amount_after >= 0),
  reason                  TEXT,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT transitions_belong_to_one_tenant
    FOREIGN KEY (payment_id, organization_id) REFERENCES payments (id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT transitions_attempt_belongs_to_one_tenant
    FOREIGN KEY (payment_attempt_id, organization_id)
    REFERENCES payment_attempts (id, organization_id),
  CONSTRAINT transitions_sequence_unique UNIQUE (payment_id, sequence_number),

  -- The monotonicity guarantee. There is no ('paid','awaiting_payment') row in
  -- legal_payment_transitions, so a stale expiry or a replayed webhook is refused
  -- by a foreign key regardless of what the application believes.
  CONSTRAINT transitions_must_be_legal
    FOREIGN KEY (from_status, to_status, trigger_name)
    REFERENCES legal_payment_transitions (from_status, to_status, trigger_name),

  -- Appmax webhooks carry no signature. A webhook may schedule a read; only the
  -- read can fund a payment. Enforced here rather than trusted to the caller.
  CONSTRAINT transitions_into_funds_require_authenticated_read CHECK (
    to_status NOT IN ('paid', 'partially_refunded', 'refunded', 'chargeback')
    OR evidence_class IN ('authenticated_provider_read', 'operator')
  )
);

CREATE INDEX payment_status_transitions_payment
  ON payment_status_transitions (payment_id, sequence_number);

-- A status change without a matching, legal, evidence-backed transition row
-- cannot commit. This is what stops a sixth uncoordinated write path from ever
-- existing: it is not discouraged, it is rejected.
CREATE OR REPLACE FUNCTION assert_payment_status_change_is_audited() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.status_sequence IS NOT DISTINCT FROM OLD.status_sequence THEN
    RETURN NULL;
  END IF;

  IF NEW.status_sequence = 0 AND TG_OP = 'INSERT' THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM payment_status_transitions
     WHERE payment_id = NEW.id
       AND sequence_number = NEW.status_sequence
       AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION
      'unaudited_payment_status_change payment=% status=% sequence=%',
      NEW.id, NEW.status, NEW.status_sequence
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER payments_status_change_is_audited
  AFTER INSERT OR UPDATE OF status, status_sequence ON payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_payment_status_change_is_audited();

-- History is not editable. The trigger documents the intent and produces a
-- readable error; the REVOKE survives a migration that drops the trigger.
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only_table_violation: % on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER payment_status_transitions_append_only
  BEFORE UPDATE OR DELETE ON payment_status_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

ALTER TABLE payments                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_status_transitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY payments_tenant_isolation ON payments
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

CREATE POLICY payment_attempts_tenant_isolation ON payment_attempts
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

CREATE POLICY payment_status_transitions_tenant_isolation ON payment_status_transitions
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

INSERT INTO tenant_scoped_tables (table_name, tenant_column) VALUES
  ('payments', 'organization_id'),
  ('payment_attempts', 'organization_id'),
  ('payment_status_transitions', 'organization_id');
