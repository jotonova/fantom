-- F8: Distribution layer — tracks where job output assets are sent after render.

CREATE TYPE "destination_kind" AS ENUM (
  'webhook',
  'youtube',
  'facebook',
  'instagram',
  'mls'
);--> statement-breakpoint

CREATE TYPE "distribution_status" AS ENUM (
  'pending',
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled'
);--> statement-breakpoint

CREATE TABLE "distributions" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"         uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "job_id"            uuid NOT NULL REFERENCES "jobs"("id") ON DELETE CASCADE,
  "asset_id"          uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
  "destination_kind"  "destination_kind" NOT NULL,
  "config"            jsonb NOT NULL DEFAULT '{}',
  "status"            "distribution_status" NOT NULL DEFAULT 'pending',
  "external_id"       text,
  "external_url"      text,
  "response_payload"  jsonb,
  "error_message"     text,
  "error_stack"       text,
  "retries"           integer NOT NULL DEFAULT 0,
  "max_retries"       integer NOT NULL DEFAULT 3,
  "started_at"        timestamptz,
  "completed_at"      timestamptz,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX "distributions_tenant_status_created_at_idx"
  ON "distributions" ("tenant_id", "status", "created_at" DESC);--> statement-breakpoint

CREATE INDEX "distributions_job_idx"
  ON "distributions" ("job_id");--> statement-breakpoint

CREATE INDEX "distributions_status_created_at_idx"
  ON "distributions" ("status", "created_at" DESC);--> statement-breakpoint

-- RLS: tenant-scoped, same GUC pattern as every other tenant table.
ALTER TABLE "distributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "distributions_isolation" ON "distributions"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ("tenant_id"::text = current_setting('app.current_tenant_id', true));--> statement-breakpoint

-- DML grants for app_user role (created in F3).
GRANT SELECT, INSERT, UPDATE, DELETE ON "distributions" TO app_user;
