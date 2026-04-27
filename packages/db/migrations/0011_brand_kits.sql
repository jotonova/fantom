-- M1.P1: Brand Kit Foundation + Async Voice Clone Training
-- Adds 'training' status to voice_clone_status enum, extends voice_clones with
-- personal-clone fields, and creates the brand_kits table with RLS + grants.

-- ── Step 1: Extend voice_clone_status enum ────────────────────────────────────
-- ALTER TYPE ADD VALUE is DDL and auto-commits in PostgreSQL; it must be the
-- first statement in this file so later statements can reference 'training'.
-- IF NOT EXISTS is a PG 9.3+ guard — safe to re-run.
ALTER TYPE "voice_clone_status" ADD VALUE IF NOT EXISTS 'training' AFTER 'pending';--> statement-breakpoint

-- ── Step 2: Extend voice_clones with personal-clone columns ───────────────────
ALTER TABLE "voice_clones"
  ADD COLUMN IF NOT EXISTS "is_personal"          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "owner_user_id"         uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "clone_failed_reason"   text;--> statement-breakpoint

-- ── Step 3: Create brand_kits table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "brand_kits" (
  "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"               uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name"                    text NOT NULL,
  "is_default"              boolean NOT NULL DEFAULT false,
  -- Logo
  "logo_asset_id"           uuid REFERENCES "assets"("id") ON DELETE SET NULL,
  -- Colors (hex strings, e.g. '#1A2B4A')
  "primary_color"           text,
  "secondary_color"         text,
  "accent_color"            text,
  -- Fonts
  "heading_font"            text,
  "body_font"               text,
  -- Bumpers
  "intro_bumper_asset_id"   uuid REFERENCES "assets"("id") ON DELETE SET NULL,
  "outro_bumper_asset_id"   uuid REFERENCES "assets"("id") ON DELETE SET NULL,
  -- Caption style
  "caption_bg_color"        text,
  "caption_text_color"      text,
  "caption_font"            text,
  "caption_position"        text,  -- 'top' | 'center' | 'bottom'
  -- Music
  "music_vibe"              text,  -- 'upbeat' | 'calm' | 'dramatic' | 'inspirational' | 'none'
  -- Audit
  "created_by_user_id"      uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"              timestamptz NOT NULL DEFAULT now(),
  "updated_at"              timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "brand_kits_tenant_idx"
  ON "brand_kits" ("tenant_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "brand_kits_tenant_default_idx"
  ON "brand_kits" ("tenant_id", "is_default");--> statement-breakpoint

-- Only one brand kit per tenant can be the default.
-- Partial unique index — rows with is_default = false are excluded, so multiple
-- non-default kits may coexist; only the one true default is constrained.
CREATE UNIQUE INDEX IF NOT EXISTS "brand_kits_default_unique"
  ON "brand_kits" ("tenant_id")
  WHERE "is_default" = true;--> statement-breakpoint

-- ── Step 4: RLS on brand_kits ─────────────────────────────────────────────────
ALTER TABLE "brand_kits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "brand_kits_isolation" ON "brand_kits";--> statement-breakpoint
CREATE POLICY "brand_kits_isolation" ON "brand_kits"
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING ("tenant_id"::text = current_setting('app.current_tenant_id', true))
  WITH CHECK ("tenant_id"::text = current_setting('app.current_tenant_id', true));--> statement-breakpoint

-- ── Step 5: Grants ────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_kits" TO app_user;--> statement-breakpoint

-- ── Step 6: Novacor default brand kit seed ────────────────────────────────────
-- Insert a starter brand kit for the Novacor tenant so the page is not empty.
-- Resolved via the admin user's tenant association. ON CONFLICT DO NOTHING is
-- safe because the partial unique index covers (tenant_id) WHERE is_default = true.
INSERT INTO "brand_kits" (
  "tenant_id",
  "name",
  "is_default",
  "primary_color",
  "secondary_color",
  "accent_color",
  "heading_font",
  "body_font",
  "music_vibe",
  "created_by_user_id"
)
SELECT
  tu."tenant_id",
  'Novacor Default',
  true,
  '#1A2B4A',
  '#C9A84C',
  '#E8EDF2',
  'Montserrat',
  'Inter',
  'inspirational',
  u."id"
FROM "users" u
JOIN "tenant_users" tu ON tu."user_id" = u."id"
WHERE u."email" = 'novacor.icaz@gmail.com'
ON CONFLICT DO NOTHING;
