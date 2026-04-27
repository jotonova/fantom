-- M1.P1 follow-up: extend brand_kits with slug/description/compliance_notes
-- and seed the 3 remaining Novacor brand kits (KW Brokerage, Amy Personal,
-- Desert ROI). Novacor Default (seeded in 0011) keeps is_default = true.

-- ── Step 1: Add missing columns ───────────────────────────────────────────────
-- slug: short machine identifier; used for ON CONFLICT idempotency below.
-- description/compliance_notes: human-readable metadata, both nullable.
ALTER TABLE "brand_kits"
  ADD COLUMN IF NOT EXISTS "slug"               text,
  ADD COLUMN IF NOT EXISTS "description"        text,
  ADD COLUMN IF NOT EXISTS "compliance_notes"   text;--> statement-breakpoint

-- ── Step 2: Partial unique index on slug ──────────────────────────────────────
-- NULL slugs are excluded so legacy rows (Novacor Default, slug IS NULL) are
-- unaffected. Only rows with an explicit slug participate in conflict detection.
CREATE UNIQUE INDEX IF NOT EXISTS "brand_kits_tenant_slug_unique"
  ON "brand_kits" ("tenant_id", "slug")
  WHERE "slug" IS NOT NULL;--> statement-breakpoint

-- ── Step 3: Seed 3 remaining Novacor kits ────────────────────────────────────
-- ON CONFLICT targets the partial unique index above — safe to re-run.

-- Kit 1: KW Brokerage
INSERT INTO "brand_kits" (
  "tenant_id",
  "name",
  "slug",
  "description",
  "compliance_notes",
  "is_default",
  "primary_color",
  "secondary_color",
  "accent_color",
  "heading_font",
  "body_font",
  "music_vibe",
  "created_by_user_id"
) VALUES (
  '8b97e0ad-523b-487f-9c68-b416e070fe04',
  'KW Brokerage',
  'kw-brokerage',
  'Required for Keller Williams listing videos. Compliance-mandated branding.',
  'Required by KW brokerage agreement for all listing-related videos.',
  false,
  '#CC0000',
  '#000000',
  '#FFFFFF',
  'Inter',
  'Inter',
  'corporate',
  '74888664-dce7-4a1b-a5bc-0331da731f3f'
)
ON CONFLICT ("tenant_id", "slug") WHERE "slug" IS NOT NULL DO NOTHING;--> statement-breakpoint

-- Kit 2: Amy Personal
INSERT INTO "brand_kits" (
  "tenant_id",
  "name",
  "slug",
  "description",
  "is_default",
  "primary_color",
  "secondary_color",
  "accent_color",
  "heading_font",
  "body_font",
  "music_vibe",
  "created_by_user_id"
) VALUES (
  '8b97e0ad-523b-487f-9c68-b416e070fe04',
  'Amy Personal',
  'amy-personal',
  'Amy Casanova personal real estate agent brand for general agent content.',
  false,
  '#1E3A8A',
  '#F59E0B',
  '#F3F4F6',
  'Montserrat',
  'Inter',
  'uplifting',
  '74888664-dce7-4a1b-a5bc-0331da731f3f'
)
ON CONFLICT ("tenant_id", "slug") WHERE "slug" IS NOT NULL DO NOTHING;--> statement-breakpoint

-- Kit 3: Desert ROI
INSERT INTO "brand_kits" (
  "tenant_id",
  "name",
  "slug",
  "description",
  "is_default",
  "primary_color",
  "secondary_color",
  "accent_color",
  "heading_font",
  "body_font",
  "music_vibe",
  "created_by_user_id"
) VALUES (
  '8b97e0ad-523b-487f-9c68-b416e070fe04',
  'Desert ROI',
  'desert-roi',
  'YouTube channel brand for all Desert ROI episodic content.',
  false,
  '#D97706',
  '#1C1917',
  '#FED7AA',
  'Bebas Neue',
  'Inter',
  'dramatic',
  '74888664-dce7-4a1b-a5bc-0331da731f3f'
)
ON CONFLICT ("tenant_id", "slug") WHERE "slug" IS NOT NULL DO NOTHING;
