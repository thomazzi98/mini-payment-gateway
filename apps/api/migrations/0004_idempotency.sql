-- Durable idempotency for unsafe merchant requests.
--
-- The guarantee is not "we check for duplicates" but "the database permits only
-- one claim". Two concurrent requests carrying the same key both attempt the
-- insert below; PostgreSQL serializes them on the unique index, one wins, and the
-- other is told what the winner did. No application-level check can offer that,
-- because between its read and its write another process fits.
--
-- The claim, the payment and the completion all commit in one transaction, so a
-- crash mid-flight rolls the key back and the merchant may simply retry. A key is
-- never left stranded in a state that blocks its own retry.

CREATE TABLE idempotency_records (
  id                    UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id       UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  environment           environment NOT NULL,

  idempotency_key       TEXT NOT NULL
                        CHECK (length(idempotency_key) BETWEEN 1 AND 255),

  -- SHA-256 over a canonical rendering of the request. The same key presented
  -- with a different body is a caller bug, not a retry, and is refused rather
  -- than silently returning the first result.
  request_fingerprint   BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  request_path          TEXT NOT NULL CHECK (length(request_path) BETWEEN 1 AND 255),

  state                 TEXT NOT NULL CHECK (state IN ('in_flight', 'completed')),

  response_status       SMALLINT CHECK (response_status BETWEEN 100 AND 599),
  response_body         JSONB,
  payment_id            UUID,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '24 hours',

  -- The constraint the whole mechanism rests on. Scoped by organization and
  -- environment, so two merchants may use the same key text independently and a
  -- sandbox key can never collide with a production one.
  CONSTRAINT idempotency_key_is_unique_per_tenant
    UNIQUE (organization_id, environment, idempotency_key),

  CONSTRAINT idempotency_completed_shape CHECK (
    (state = 'completed') = (response_status IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT idempotency_expiry_after_creation CHECK (expires_at > created_at),

  -- A record may only point at a payment of its own tenant.
  CONSTRAINT idempotency_payment_belongs_to_one_tenant
    FOREIGN KEY (payment_id, organization_id) REFERENCES payments (id, organization_id)
    ON DELETE CASCADE
);

CREATE INDEX idempotency_records_expiry ON idempotency_records (expires_at);

ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY idempotency_records_tenant_isolation ON idempotency_records
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

INSERT INTO tenant_scoped_tables (table_name, tenant_column) VALUES
  ('idempotency_records', 'organization_id');
