-- Enable Row-Level Security on tenant-scoped tables.
-- The `users` table is intentionally excluded: a user identity is cross-tenant
-- and is scoped by the tenant_users junction table at the application layer.

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- RLS policy: tenants are visible only within the active tenant session.
-- current_setting('app.current_tenant_id', true) returns NULL when the GUC is
-- not set (missing_ok = true). A NULL comparison evaluates to false, so all
-- rows are hidden when no tenant context is active.
DROP POLICY IF EXISTS "tenants_isolation" ON "tenants";--> statement-breakpoint
CREATE POLICY "tenants_isolation" ON "tenants"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ("id"::text = current_setting('app.current_tenant_id', true));--> statement-breakpoint

-- RLS policy: tenant_users rows are visible only within the active tenant.
DROP POLICY IF EXISTS "tenant_users_isolation" ON "tenant_users";--> statement-breakpoint
CREATE POLICY "tenant_users_isolation" ON "tenant_users"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ("tenant_id"::text = current_setting('app.current_tenant_id', true));--> statement-breakpoint

-- RLS policy: tenant_settings rows are visible only within the active tenant.
DROP POLICY IF EXISTS "tenant_settings_isolation" ON "tenant_settings";--> statement-breakpoint
CREATE POLICY "tenant_settings_isolation" ON "tenant_settings"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ("tenant_id"::text = current_setting('app.current_tenant_id', true));
