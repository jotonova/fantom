-- F5: Asset Library + Voice Vault schema
-- Creates assets and voice_clones tables with RLS and app_user grants.
-- Written manually (not via drizzle-kit) because the DB snapshot is not
-- available locally. Run `pnpm --filter @fantom/db db:generate` against a
-- live DB after this migration deploys to re-sync the drizzle-kit snapshot.

-- ── Enums ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "asset_kind" AS ENUM ('image', 'audio', 'video', 'document', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "voice_clone_provider" AS ENUM ('elevenlabs', 'openai', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "voice_clone_default_kind" AS ENUM ('listing_video', 'market_update', 'virtual_tour', 'flip_video', 'general');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "voice_clone_status" AS ENUM ('pending', 'processing', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- ── assets ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "assets" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"            uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "uploaded_by_user_id"  uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "kind"                 "asset_kind" NOT NULL,
  "original_filename"    text NOT NULL,
  "mime_type"            text NOT NULL,
  "size_bytes"           bigint NOT NULL,
  "r2_key"               text NOT NULL UNIQUE,
  "width"                integer,
  "height"               integer,
  "duration_seconds"     numeric,
  "metadata"             jsonb NOT NULL DEFAULT '{}',
  "tags"                 text[] NOT NULL DEFAULT '{}',
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "assets_tenant_kind_idx"       ON "assets" ("tenant_id", "kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_tenant_created_at_idx" ON "assets" ("tenant_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_tags_gin_idx"          ON "assets" USING GIN ("tags");--> statement-breakpoint

ALTER TABLE "assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "assets_isolation" ON "assets";--> statement-breakpoint
CREATE POLICY "assets_isolation" ON "assets"
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING ("tenant_id"::text = current_setting('app.current_tenant_id', true));--> statement-breakpoint

-- ── voice_clones ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "voice_clones" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"            uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name"                 text NOT NULL,
  "description"          text,
  "provider"             "voice_clone_provider" NOT NULL DEFAULT 'elevenlabs',
  "provider_voice_id"    text,
  "is_default_for_kind"  "voice_clone_default_kind",
  "source_asset_id"      uuid REFERENCES "assets"("id") ON DELETE SET NULL,
  "status"               "voice_clone_status" NOT NULL DEFAULT 'pending',
  "created_by_user_id"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "voice_clones_tenant_idx" ON "voice_clones" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_clones_tenant_default_kind_idx" ON "voice_clones" ("tenant_id", "is_default_for_kind");--> statement-breakpoint

-- One default voice per kind per tenant (partial unique — NULL values are excluded).
CREATE UNIQUE INDEX IF NOT EXISTS "voice_clones_default_kind_unique"
  ON "voice_clones" ("tenant_id", "is_default_for_kind")
  WHERE "is_default_for_kind" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "voice_clones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "voice_clones_isolation" ON "voice_clones";--> statement-breakpoint
CREATE POLICY "voice_clones_isolation" ON "voice_clones"
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING ("tenant_id"::text = current_setting('app.current_tenant_id', true));--> statement-breakpoint

-- ── app_user grants ───────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON "assets"       TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "voice_clones" TO app_user;
