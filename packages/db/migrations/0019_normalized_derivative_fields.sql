-- 1A.8: Normalized derivative fields
-- Extends assets table with fields for the color-corrected + audio-normalized
-- H.264/AAC derivative file produced by the normalization step.
-- All columns are NULLABLE — normalization is best-effort and non-blocking.

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "normalized_r2_key"       text,
  ADD COLUMN IF NOT EXISTS "normalized_size_bytes"   bigint,
  ADD COLUMN IF NOT EXISTS "normalized_codec"        text,
  ADD COLUMN IF NOT EXISTS "normalized_audio_codec"  text,
  ADD COLUMN IF NOT EXISTS "loudness_lufs"           numeric,
  ADD COLUMN IF NOT EXISTS "loudness_truepeak_db"    numeric;
