-- M1.P2.engine: Multi-modal render engine
-- Renames photo_asset_ids → input_asset_ids (now supports images AND video clips)
-- Adds co_brand_kit_id, compliance_kit_id, motion_hints, sfx_prompt, asset_render_status
-- Creates runway_usage table for per-tenant cost tracking and budget enforcement

-- ── Step 1: Rename photo_asset_ids → input_asset_ids ──────────────────────────
ALTER TABLE "shorts_jobs" RENAME COLUMN "photo_asset_ids" TO "input_asset_ids";--> statement-breakpoint

-- ── Step 2: Add new shorts_jobs columns ───────────────────────────────────────
ALTER TABLE "shorts_jobs"
  ADD COLUMN IF NOT EXISTS "co_brand_kit_id"       uuid REFERENCES "brand_kits"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "compliance_kit_id"     uuid REFERENCES "brand_kits"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "motion_hints"          jsonb,
  ADD COLUMN IF NOT EXISTS "sfx_prompt"            text,
  ADD COLUMN IF NOT EXISTS "asset_render_status"   jsonb;--> statement-breakpoint

-- ── Step 3: Create runway_usage table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "runway_usage" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"     uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "shorts_job_id" uuid REFERENCES "shorts_jobs"("id") ON DELETE SET NULL,
  "asset_id"      text NOT NULL,
  "task_id"       text NOT NULL,
  "credits_used"  integer NOT NULL,
  "cost_usd"      numeric(10, 4) NOT NULL,
  "billed_at"     timestamptz NOT NULL DEFAULT now(),
  "created_at"    timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- ── Step 4: Enable RLS ────────────────────────────────────────────────────────
ALTER TABLE "runway_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── Step 5: RLS Policy ────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'runway_usage' AND policyname = 'runway_usage_tenant_isolation'
  ) THEN
    CREATE POLICY "runway_usage_tenant_isolation" ON "runway_usage"
      USING (
        "tenant_id" = (current_setting('app.current_tenant_id', true))::uuid
        OR current_setting('app.is_platform_admin', true) = 'true'
      )
      WITH CHECK (
        "tenant_id" = (current_setting('app.current_tenant_id', true))::uuid
        OR current_setting('app.is_platform_admin', true) = 'true'
      );
  END IF;
END $$;--> statement-breakpoint

-- ── Step 6: Grants ─────────────────────────────────────────────────────────────
GRANT SELECT, INSERT ON "runway_usage" TO "app_user";
