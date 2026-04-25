-- F7 fix: add a permissive SELECT-only policy on the tenants table so app_user
-- can look up a tenant by slug before any GUC is established.
--
-- Background: tenants_isolation (FOR ALL) requires app.current_tenant_id to match
-- the tenant's id. This is correct for INSERT/UPDATE/DELETE. But for the bootstrap
-- slug lookup in tenant-context middleware, we need to resolve the tenant ID from
-- the slug BEFORE we know the ID — making it impossible to set the GUC first.
--
-- This policy adds a permissive SELECT-only bypass. With two permissive policies,
-- PostgreSQL returns a row if it matches EITHER condition. So:
--   SELECT: any tenant row is visible (bootstrap policy wins)
--   INSERT/UPDATE/DELETE: only the matching tenant is accessible (isolation policy wins)
--
-- The tenants table contains only public metadata (name, slug). All sensitive
-- tenant-scoped data lives in other tables that retain full RLS isolation.

DROP POLICY IF EXISTS "tenants_select_bootstrap" ON "tenants";--> statement-breakpoint
CREATE POLICY "tenants_select_bootstrap" ON "tenants"
  AS PERMISSIVE
  FOR SELECT
  TO app_user
  USING (true);
