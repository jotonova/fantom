-- F9b: Observability — event log, alert throttle, RLS policies, platform_admin seed.
-- Runs after 0008_platform_admin_enum.sql has committed, so 'platform_admin' is
-- safe to reference in the UPDATE below.

-- Step 1: Severity enum for structured event log.
CREATE TYPE "event_severity" AS ENUM (
  'debug',
  'info',
  'warn',
  'error',
  'critical'
);--> statement-breakpoint

-- Step 2: events table — structured operator-visible event log.
-- tenant_id SET NULL on tenant delete to preserve events for audit purposes.
CREATE TABLE "events" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"       uuid REFERENCES "tenants"("id") ON DELETE SET NULL,
  "kind"            text NOT NULL,
  "severity"        "event_severity" NOT NULL DEFAULT 'info',
  "actor_user_id"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "subject_type"    text,
  "subject_id"      uuid,
  "metadata"        jsonb NOT NULL DEFAULT '{}',
  "error_message"   text,
  "error_stack"     text,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX "events_tenant_created_at_idx" ON "events" ("tenant_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "events_severity_created_at_idx" ON "events" ("severity", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "events_kind_created_at_idx" ON "events" ("kind", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "events_subject_idx" ON "events" ("subject_type", "subject_id");--> statement-breakpoint

-- Step 3: alert_throttle table — per-tenant per-kind alert rate limiting.
-- No RLS (operator-internal; only the API/worker reads/writes this table).
CREATE TABLE "alert_throttle" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"         uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "event_kind"        text NOT NULL,
  "last_alerted_at"   timestamptz NOT NULL,
  "alerts_sent_today" integer NOT NULL DEFAULT 0,
  "day_key"           date NOT NULL,
  CONSTRAINT "alert_throttle_tenant_kind_day" UNIQUE ("tenant_id", "event_kind", "day_key")
);--> statement-breakpoint

-- Step 4: RLS on events table.
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Tenant users see their own events at severity <= 'warn' (no error/critical stacks).
CREATE POLICY "events_tenant_select" ON "events"
  AS PERMISSIVE
  FOR SELECT
  TO app_user
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    AND severity IN ('debug', 'info', 'warn')
  );--> statement-breakpoint

-- Platform admins (GUC app.is_platform_admin = 'true') see ALL events with no filter.
CREATE POLICY "events_admin_select" ON "events"
  AS PERMISSIVE
  FOR SELECT
  TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true');--> statement-breakpoint

-- app_user can insert any event (system events may have null tenant_id).
CREATE POLICY "events_insert" ON "events"
  AS PERMISSIVE
  FOR INSERT
  TO app_user
  WITH CHECK (true);--> statement-breakpoint

-- Step 5: Admin SELECT policies on existing tables.
-- These OR with the existing isolation policies so platform admins
-- (app.is_platform_admin = 'true') can query across all tenants.

CREATE POLICY "jobs_admin_select" ON "jobs"
  AS PERMISSIVE
  FOR SELECT
  TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true');--> statement-breakpoint

CREATE POLICY "distributions_admin_select" ON "distributions"
  AS PERMISSIVE
  FOR SELECT
  TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true');--> statement-breakpoint

CREATE POLICY "assets_admin_select" ON "assets"
  AS PERMISSIVE
  FOR SELECT
  TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true');--> statement-breakpoint

CREATE POLICY "tenants_admin_select" ON "tenants"
  AS PERMISSIVE
  FOR SELECT
  TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true');--> statement-breakpoint

-- Step 6: Grants for app_user.
GRANT SELECT, INSERT ON "events" TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "alert_throttle" TO app_user;--> statement-breakpoint

-- Step 7: Promote Justin to platform_admin.
-- Safe to reference 'platform_admin' here because 0008_platform_admin_enum.sql
-- committed that enum value in its own transaction before this migration runs.
-- Idempotent — safe to re-run.
UPDATE "tenant_users"
SET "role" = 'platform_admin'
WHERE "user_id" = (SELECT "id" FROM "users" WHERE "email" = 'novacor.icaz@gmail.com');
