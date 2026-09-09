-- Creates the role the application actually connects as.
--
-- It is deliberately NOT the owner of any table and does NOT hold BYPASSRLS, which
-- is what makes the row level security policies in migration 0002 binding rather
-- than advisory. The owner role is reserved for migrations.
--
-- Re-run on every startup and idempotent: new tables created by a later migration
-- need the same grants, and default privileges only cover objects created after
-- they are set.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'payment_gateway_application') THEN
    CREATE ROLE payment_gateway_application LOGIN;
  END IF;
END
$$;

ALTER ROLE payment_gateway_application WITH
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS
  PASSWORD :'application_password';

GRANT CONNECT ON DATABASE :"database_name" TO payment_gateway_application;
GRANT USAGE ON SCHEMA public TO payment_gateway_application;

-- No CREATE on the schema. A SQL injection foothold in the application must not be
-- able to add a table, replace a function, or drop a policy.
REVOKE CREATE ON SCHEMA public FROM payment_gateway_application;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO payment_gateway_application;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO payment_gateway_application;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public
  TO payment_gateway_application;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO payment_gateway_application;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO payment_gateway_application;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO payment_gateway_application;

-- The migrator's own bookkeeping. The application has no reason to read it and
-- certainly no reason to write it.
REVOKE ALL ON TABLE schema_migrations FROM payment_gateway_application;

-- The registry of tenant-scoped tables is a fact about the schema, not application
-- state. Readable so the admin surface can show it; never writable.
REVOKE INSERT, UPDATE, DELETE ON TABLE tenant_scoped_tables
  FROM payment_gateway_application;

-- Records what this script established, so a drift check has something to compare.
SELECT
  rolname,
  rolsuper       AS is_superuser,
  rolbypassrls   AS bypasses_row_level_security,
  rolcreatedb    AS can_create_database
FROM pg_roles
WHERE rolname = 'payment_gateway_application';
