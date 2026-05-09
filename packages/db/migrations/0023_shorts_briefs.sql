-- Phase 1B.1: Shorts Briefs — campaign intent layer upstream of shorts_jobs.
-- One brief captures the creative brief; workers will translate it into shorts_jobs renders.
-- voice_clone_id is a text ElevenLabs voice ID, not a FK to voice_clones.
-- status: draft → ready → rendering → rendered | failed

CREATE TABLE IF NOT EXISTS "shorts_briefs" (
  "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"           uuid        NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "created_by_user_id"  uuid        REFERENCES "users"("id") ON DELETE SET NULL,

  -- Input assets (ordered array of source asset UUIDs)
  "source_asset_ids"    uuid[]      NOT NULL DEFAULT '{}',

  -- Brief metadata
  "title"               text        NOT NULL,
  "description"         text,

  -- Voice & Brand
  "brand_kit_id"        uuid        REFERENCES "brand_kits"("id") ON DELETE SET NULL,
  "voice_clone_id"      text,       -- ElevenLabs voice ID — intentionally not a FK

  -- Duration (allowed values: 15, 30, 45, 60 seconds)
  "duration_seconds"    integer     NOT NULL DEFAULT 30
    CONSTRAINT shorts_briefs_duration_check CHECK (duration_seconds IN (15, 30, 45, 60)),

  -- AI-generated content (nullable — populated by the brief-planning step)
  "main_scenes"         jsonb,
  "voiceover_scripts"   jsonb,

  -- Status lifecycle
  "status"              text        NOT NULL DEFAULT 'draft'
    CONSTRAINT shorts_briefs_status_check CHECK (
      status IN ('draft', 'ready', 'rendering', 'rendered', 'failed')
    ),
  "error_message"       text,

  -- Audit
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shorts_briefs_tenant_status_idx"
  ON "shorts_briefs" ("tenant_id", "status");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shorts_briefs_tenant_created_at_idx"
  ON "shorts_briefs" ("tenant_id", "created_at");--> statement-breakpoint

ALTER TABLE "shorts_briefs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "shorts_briefs_tenant_isolation" ON "shorts_briefs"
  USING (
    "tenant_id" = (current_setting('app.current_tenant_id', true))::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    "tenant_id" = (current_setting('app.current_tenant_id', true))::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  );--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "shorts_briefs" TO "app_user";
