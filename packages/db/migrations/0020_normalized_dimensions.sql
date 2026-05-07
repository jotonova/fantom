-- 1A.8 OOM fix: track final output dimensions of normalized derivative
-- Needed because 4K source is downscaled to 1080p during normalization.

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "normalized_width"  integer,
  ADD COLUMN IF NOT EXISTS "normalized_height" integer;
