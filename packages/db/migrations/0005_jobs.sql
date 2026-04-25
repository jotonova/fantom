-- F6: Job Queue schema
-- Creates the jobs table with RLS and app_user grants.
-- Supports the render pipeline: pending → queued → processing → completed/failed.

-- ── Enums ─────────────────────────────────────────────────────────────────────

CREATE TYPE "job_kind" AS ENUM (
  'render_test_video',
  'render_listing_video',
  'render_market_update',
  'render_virtual_tour',
  'render_flip_video',
  'render_youtube_edit'
);--> statement-breakpoint

CREATE TYPE "job_status" AS ENUM (
  'pending',
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled'
);--> statement-breakpoint

-- ── jobs ──────────────────────────────────────────────────────────────────────

CREATE TABLE "jobs" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"             uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "created_by_user_id"    uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "kind"                  "job_kind" NOT NULL,
  "status"                "job_status" NOT NULL DEFAULT 'pending',
  "progress"              integer NOT NULL DEFAULT 0,
  "input"                 jsonb NOT NULL DEFAULT '{}',
  "output_asset_id"       uuid REFERENCES "assets"("id") ON DELETE SET NULL,
  "error_message"         text,
  "error_stack"           text,
  "retries"               integer NOT NULL DEFAULT 0,
  "max_retries"           integer NOT NULL DEFAULT 2,
  "started_at"            timestamptz,
  "completed_at"          timestamptz,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- For the jobs list page (tenant-scoped, newest first, filterable by status)
CREATE INDEX "jobs_tenant_status_created_at_idx"
  ON "jobs" ("tenant_id", "status", "created_at" DESC);--> statement-breakpoint

-- For the worker pickup query (find next pending/queued job)
CREATE INDEX "jobs_status_created_at_idx"
  ON "jobs" ("status", "created_at");--> statement-breakpoint

ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "jobs_isolation" ON "jobs"
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING ("tenant_id"::text = current_setting('app.current_tenant_id', true));--> statement-breakpoint

-- ── app_user grants ───────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON "jobs" TO app_user;
