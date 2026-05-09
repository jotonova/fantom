-- Migration 0025: shorts_renders table
-- Tracks each render job attempt for a shorts brief.

CREATE TABLE IF NOT EXISTS "shorts_renders" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"         uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "brief_id"          uuid NOT NULL REFERENCES "shorts_briefs"("id") ON DELETE CASCADE,
  "status"            text NOT NULL DEFAULT 'queued'
                        CONSTRAINT shorts_renders_status_check
                        CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  "bullmq_job_id"     text,
  "output_asset_id"   uuid REFERENCES "assets"("id") ON DELETE SET NULL,
  "error_message"     text,
  "started_at"        timestamptz,
  "finished_at"       timestamptz,
  "duration_ms"       integer,
  "cost_estimate_usd" numeric(10,4),
  "cost_actual_usd"   numeric(10,4),
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "shorts_renders" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "shorts_renders"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "shorts_renders" TO app_user;

CREATE INDEX IF NOT EXISTS "shorts_renders_brief_id_idx"
  ON "shorts_renders" ("brief_id");

CREATE INDEX IF NOT EXISTS "shorts_renders_tenant_status_idx"
  ON "shorts_renders" ("tenant_id", "status");
