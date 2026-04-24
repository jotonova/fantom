-- F3: Create restricted database role for the running API.
--
-- After this migration runs, Justin must:
--   1. Copy the generated password from Render deploy logs (RAISE NOTICE output).
--   2. Build a new connection string: postgres://app_user:<password>@<host>/<dbname>
--   3. Add MIGRATE_DATABASE_URL = current DATABASE_URL value (owner role — for future migrations).
--   4. Replace DATABASE_URL with the new app_user connection string.
--   5. Redeploy the API service on Render.
--
-- See docs/DEPLOYMENT.md — "Database Role Hardening" for the full procedure.

DO $$
DECLARE
  v_password text;
  v_role_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') INTO v_role_exists;

  IF NOT v_role_exists THEN
    -- Generate a 64-character random password using built-in Postgres functions.
    -- sha256 is available in Postgres 11+ core (no pgcrypto extension required).
    v_password := encode(sha256((gen_random_uuid()::text || gen_random_uuid()::text)::bytea), 'hex');

    EXECUTE format(
      'CREATE ROLE app_user WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
      v_password
    );

    RAISE NOTICE '';
    RAISE NOTICE '╔═══════════════════════════════════════════════════════════╗';
    RAISE NOTICE '║          app_user ROLE CREATED — SAVE THIS PASSWORD       ║';
    RAISE NOTICE '╠═══════════════════════════════════════════════════════════╣';
    RAISE NOTICE '║  Password: %  ║', v_password;
    RAISE NOTICE '╠═══════════════════════════════════════════════════════════╣';
    RAISE NOTICE '║  New DATABASE_URL:                                        ║';
    RAISE NOTICE '║  postgres://app_user:<password>@<render-host>/<dbname>    ║';
    RAISE NOTICE '║                                                           ║';
    RAISE NOTICE '║  See docs/DEPLOYMENT.md → Database Role Hardening        ║';
    RAISE NOTICE '╚═══════════════════════════════════════════════════════════╝';
    RAISE NOTICE '';
  ELSE
    RAISE NOTICE 'app_user role already exists — skipping creation.';
    RAISE NOTICE 'To reset password: ALTER ROLE app_user WITH PASSWORD ''new-password'';';
  END IF;
END $$;

-- Schema access
GRANT USAGE ON SCHEMA public TO app_user;

-- DML on tenant-scoped and auth tables (no DDL, no role management)
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants,
  users,
  tenant_users,
  tenant_settings,
  sessions
TO app_user;

-- Migration history: read-only, needed by GET /db/health to report migrationsApplied.
-- Granted best-effort — if the drizzle schema doesn't exist yet, this is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle'
  ) THEN
    GRANT USAGE ON SCHEMA drizzle TO app_user;
    GRANT SELECT ON drizzle.__drizzle_migrations TO app_user;
  END IF;
END $$;
