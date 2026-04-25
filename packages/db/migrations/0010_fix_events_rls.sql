-- 0010: Fix events INSERT RLS policy to be explicit about null-tenant system events.
--
-- The original policy (0009) used WITH CHECK (true), which should allow all inserts,
-- but produces a 42501 RLS violation in production for system-level events where
-- tenant_id IS NULL and no current_tenant_id GUC is set.  Replacing it with an
-- explicit condition makes the intent unambiguous and matches how every other
-- insert path in the codebase is already guarded.

DROP POLICY IF EXISTS "events_insert" ON "events";--> statement-breakpoint

CREATE POLICY "events_insert" ON "events"
  AS PERMISSIVE
  FOR INSERT
  TO app_user
  WITH CHECK (
    tenant_id IS NULL
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
