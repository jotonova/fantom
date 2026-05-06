-- 1A.2: AssemblyAI cost tracking
-- Creates assemblyai_usage table for per-tenant transcription spend tracking
-- with RLS isolation. Used by the cost cap infrastructure in the worker.

-- ── Step 1: Create table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "assemblyai_usage" (
  "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"         uuid        NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "asset_id"          uuid        REFERENCES "assets"("id") ON DELETE SET NULL,
  "audio_seconds"     numeric     NOT NULL,
  "cost_usd"          numeric     NOT NULL,
  "model"             text        NOT NULL DEFAULT 'universal-2',
  "transcription_id"  text,
  "created_at"        timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- ── Step 2: Indexes ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "assemblyai_usage_tenant_created_at_idx"
  ON "assemblyai_usage" ("tenant_id", "created_at" DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "assemblyai_usage_created_at_idx"
  ON "assemblyai_usage" ("created_at" DESC);--> statement-breakpoint

-- ── Step 3: Enable RLS ────────────────────────────────────────────────────────
ALTER TABLE "assemblyai_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── Step 4: RLS policy ───────────────────────────────────────────────────────
-- Permissive policy scoped to app.current_tenant_id GUC, same pattern as
-- assets table. Platform admin bypass via is_platform_admin GUC allows the
-- worker to INSERT and SELECT across tenant boundaries when needed.
DROP POLICY IF EXISTS "assemblyai_usage_isolation" ON "assemblyai_usage";--> statement-breakpoint
CREATE POLICY "assemblyai_usage_isolation" ON "assemblyai_usage"
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    "tenant_id"::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    "tenant_id"::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.is_platform_admin', true) = 'true'
  );--> statement-breakpoint

-- ── Step 5: Grants ────────────────────────────────────────────────────────────
GRANT SELECT, INSERT ON "assemblyai_usage" TO "app_user";
