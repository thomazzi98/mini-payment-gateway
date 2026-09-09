-- Tenant isolation enforced by PostgreSQL rather than by remembering a WHERE clause.
--
-- The application connects as a role that is NOT the table owner and does NOT hold
-- BYPASSRLS, so every policy below applies to it unconditionally. A missing filter
-- in application code therefore returns nothing instead of returning another
-- merchant's rows.

-- Reads the organization for the current transaction.
--
-- Returns NULL when nothing has been set, and `organization_id = NULL` is NULL
-- rather than true, so an unscoped connection sees zero rows. The failure mode of
-- forgetting to set the context is an empty result, never a leak.
CREATE FUNCTION current_organization_id() RETURNS UUID
  LANGUAGE sql
  STABLE
  -- Pinned so a caller cannot shadow a referenced object with one of their own.
  SET search_path = pg_catalog, public
AS $$
  SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid
$$;

COMMENT ON FUNCTION current_organization_id() IS
  'The organization scope for the current transaction, set by set_config(''app.organization_id'', ...). NULL means unscoped, which every policy treats as no access.';

-- Authenticating a request is the one lookup that cannot already know its own
-- tenant: the organization is the result of the lookup, not an input to it.
--
-- SECURITY DEFINER runs this single function as the owner so it can read the row,
-- while the table itself stays closed to the application role. It takes the unique
-- key identifier, so it can return at most one row and cannot be used to enumerate.
-- It returns the stored hash, never a secret; the caller compares in constant time.
CREATE FUNCTION authenticate_api_key(candidate_identifier TEXT)
RETURNS TABLE (
  api_key_id       UUID,
  organization_id  UUID,
  environment      environment,
  key_hash         BYTEA,
  scopes           TEXT[],
  revoked_at       TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  organization_archived_at TIMESTAMPTZ
)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT
    api_keys.id,
    api_keys.organization_id,
    api_keys.environment,
    api_keys.key_hash,
    api_keys.scopes,
    api_keys.revoked_at,
    api_keys.expires_at,
    organizations.archived_at
  FROM api_keys
  JOIN organizations ON organizations.id = api_keys.organization_id
  WHERE api_keys.key_identifier = candidate_identifier
$$;

COMMENT ON FUNCTION authenticate_api_key(TEXT) IS
  'Resolves one API key by its public identifier so a request can establish its tenant. Returns the stored hash for constant-time comparison, never a secret.';

-- Recording use is likewise pre-tenant: it happens as part of authenticating.
-- Confined to a single row addressed by primary key, and it can only ever move the
-- timestamp forward.
CREATE FUNCTION record_api_key_use(used_api_key_id UUID) RETURNS VOID
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  UPDATE api_keys SET last_used_at = now() WHERE id = used_api_key_id
$$;

ALTER TABLE organizations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys                 ENABLE ROW LEVEL SECURITY;

CREATE POLICY organizations_tenant_isolation ON organizations
  USING (id = current_organization_id())
  WITH CHECK (id = current_organization_id());

CREATE POLICY organization_memberships_tenant_isolation ON organization_memberships
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

CREATE POLICY api_keys_tenant_isolation ON api_keys
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- A registry of which tables carry tenant data and must therefore have RLS.
-- A test reads this and fails when a tenant-owned table is added without a policy,
-- which is the mistake that quietly reopens cross-tenant access months from now.
CREATE TABLE tenant_scoped_tables (
  table_name        TEXT PRIMARY KEY,
  tenant_column     TEXT NOT NULL DEFAULT 'organization_id',
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant_scoped_tables IS
  'Every table holding tenant data. Enforced by a test that compares this list against pg_policies.';

INSERT INTO tenant_scoped_tables (table_name, tenant_column) VALUES
  ('organizations', 'id'),
  ('organization_memberships', 'organization_id'),
  ('api_keys', 'organization_id');
