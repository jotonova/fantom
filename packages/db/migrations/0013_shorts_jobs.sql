-- M1.P2.a: Shorts Render Pipeline
-- Adds short_vibe, script_source, caption_source, short_status enums,
-- adds render_short_video to job_kind enum, and creates the shorts_jobs table.

-- ── Step 1: Extend job_kind enum ──────────────────────────────────────────────
-- Must run outside a transaction (ALTER TYPE ADD VALUE is non-transactional).
ALTER TYPE "job_kind" ADD VALUE IF NOT EXISTS 'render_short_video';--> statement-breakpoint

-- ── Step 2: Create short_vibe enum ────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "short_vibe" AS ENUM (
    'excited_reveal',
    'calm_walkthrough',
    'educational_breakdown'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- ── Step 3: Create script_source enum ─────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "script_source" AS ENUM (
    'ai_generated',
    'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- ── Step 4: Create caption_source enum ────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "caption_source" AS ENUM (
    'ai_generated',
    'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- ── Step 5: Create short_status enum ──────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "short_status" AS ENUM (
    'draft',
    'rendering',
    'rendered',
    'approved',
    'scheduled',
    'posted',
    'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- ── Step 6: Create shorts_jobs table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "shorts_jobs" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"             uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "created_by_user_id"    uuid REFERENCES "users"("id") ON DELETE SET NULL,

  -- Brand & Voice
  "brand_kit_id"          uuid REFERENCES "brand_kits"("id") ON DELETE SET NULL,
  "voice_clone_id"        uuid REFERENCES "voice_clones"("id") ON DELETE SET NULL,

  -- Photo assets (ordered array of asset IDs)
  "photo_asset_ids"       uuid[] NOT NULL DEFAULT '{}',

  -- Script
  "vibe"                  "short_vibe" NOT NULL DEFAULT 'calm_walkthrough',
  "script_source"         "script_source" NOT NULL DEFAULT 'ai_generated',
  "script"                text,

  -- Captions
  "caption_source"        "caption_source" NOT NULL DEFAULT 'ai_generated',
  "caption_text"          text,

  -- Music
  "music_vibe"            text,

  -- Duration
  "target_duration_seconds" integer NOT NULL DEFAULT 60,

  -- Render job linkage
  "render_job_id"         uuid REFERENCES "jobs"("id") ON DELETE SET NULL,

  -- Output
  "output_asset_id"       uuid REFERENCES "assets"("id") ON DELETE SET NULL,

  -- Scheduling
  "scheduled_for"         timestamptz,
  "posted_at"             timestamptz,

  -- Status
  "status"                "short_status" NOT NULL DEFAULT 'draft',
  "error_message"         text,

  -- Audit
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- ── Step 7: Indexes ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "shorts_jobs_tenant_status_idx"
  ON "shorts_jobs" ("tenant_id", "status");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shorts_jobs_tenant_scheduled_idx"
  ON "shorts_jobs" ("tenant_id", "scheduled_for")
  WHERE "scheduled_for" IS NOT NULL;--> statement-breakpoint

-- ── Step 8: Row-Level Security ─────────────────────────────────────────────────
ALTER TABLE "shorts_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "shorts_jobs_tenant_isolation" ON "shorts_jobs"
  USING (
    "tenant_id" = (current_setting('app.current_tenant_id', true))::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    "tenant_id" = (current_setting('app.current_tenant_id', true))::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  );--> statement-breakpoint

-- ── Step 9: Grants ─────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "shorts_jobs" TO "app_user";
