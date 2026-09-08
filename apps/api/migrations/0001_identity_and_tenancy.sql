-- Identity, tenancy and API credentials.
--
-- Every tenant-scoped table added later carries organization_id and enables row
-- level security against it, so isolation is a property of the schema rather than
-- something each query has to remember.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE environment AS ENUM ('SANDBOX', 'PRODUCTION');
CREATE TYPE organization_role AS ENUM ('OWNER', 'ADMIN', 'DEVELOPER', 'VIEWER');

-- Identifiers that appear in URLs and API responses are opaque and prefixed, so a
-- caller cannot enumerate resources by incrementing an integer, and a leaked value
-- is recognisable in a log.
CREATE DOMAIN public_identifier AS TEXT
  CHECK (VALUE ~ '^[a-z]{2,12}_[0-9a-hjkmnp-tv-z]{26}$');

CREATE TABLE organizations (
  id                        UUID PRIMARY KEY DEFAULT uuidv7(),
  public_id                 public_identifier NOT NULL UNIQUE,
  name                      TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  slug                      TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),

  -- Production is opt-in. A newly created organization can only transact in
  -- sandbox until someone deliberately enables it.
  is_production_enabled     BOOLEAN NOT NULL DEFAULT FALSE,

  -- The legacy system enforced its ceiling with a JavaScript alert(). Here it is a
  -- column, checked server side, and the payment table references it.
  maximum_payment_amount_minor BIGINT NOT NULL DEFAULT 300000
                            CHECK (maximum_payment_amount_minor > 0),

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at               TIMESTAMPTZ
);

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  public_id         public_identifier NOT NULL UNIQUE,
  email             CITEXT NOT NULL UNIQUE CHECK (position('@' IN email) > 1),
  full_name         TEXT NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 200),
  password_hash     TEXT NOT NULL,

  -- The one place tenant isolation is deliberately relaxed. Kept as an explicit
  -- column so "who can see across organizations" is answerable with one query.
  is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at       TIMESTAMPTZ
);

CREATE TABLE organization_memberships (
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role            organization_role NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX organization_memberships_user_idx ON organization_memberships (user_id);

-- Every organization keeps at least one owner. Enforced in application code within
-- the same transaction as a role change; the index makes the check cheap.
CREATE INDEX organization_memberships_owner_idx
  ON organization_memberships (organization_id)
  WHERE role = 'OWNER';

CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  -- An API key is bound to exactly one environment. A sandbox key cannot reach
  -- production data even if every other check were to fail.
  environment     environment NOT NULL,

  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),

  -- The lookup half of the key: public, indexed, and safe to log.
  key_identifier  TEXT NOT NULL UNIQUE CHECK (key_identifier ~ '^[0-9a-zA-Z]{12}$'),
  -- The verifier: HMAC-SHA256 of the secret half under a server-side pepper.
  -- The secret itself is never stored, so a database dump does not yield a usable key.
  key_hash        BYTEA NOT NULL CHECK (octet_length(key_hash) = 32),
  last_four       TEXT NOT NULL CHECK (last_four ~ '^[0-9a-zA-Z]{4}$'),

  scopes          TEXT[] NOT NULL CHECK (cardinality(scopes) > 0),

  created_by_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,

  CONSTRAINT api_keys_expiry_after_creation CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX api_keys_organization_idx ON api_keys (organization_id, environment);

-- A production key may only exist for an organization that has production enabled.
-- The composite foreign key makes that a schema guarantee rather than a check that
-- someone has to remember to write.
ALTER TABLE organizations ADD CONSTRAINT organizations_production_gate UNIQUE (id, is_production_enabled);

CREATE OR REPLACE FUNCTION assert_api_key_environment_is_permitted() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  production_enabled BOOLEAN;
BEGIN
  IF NEW.environment <> 'PRODUCTION' THEN
    RETURN NEW;
  END IF;

  SELECT is_production_enabled INTO production_enabled
    FROM organizations WHERE id = NEW.organization_id;

  IF production_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'production_not_enabled_for_organization %', NEW.organization_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER api_keys_environment_is_permitted
  BEFORE INSERT OR UPDATE OF environment, organization_id ON api_keys
  FOR EACH ROW EXECUTE FUNCTION assert_api_key_environment_is_permitted();

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER organizations_touch_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
