-- 1A.2: Video preprocessing fields
-- Extends assets table with codec/fps/bitrate metadata, transcription state,
-- scene detection output, thumbnail pointer, and preprocessed_at timestamp.
-- All columns are NULLABLE — existing image/audio assets are unaffected.

-- ── Step 1: Add preprocessing columns ────────────────────────────────────────
ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "codec"                       text,
  ADD COLUMN IF NOT EXISTS "fps"                         numeric,
  ADD COLUMN IF NOT EXISTS "bitrate_kbps"                integer,
  ADD COLUMN IF NOT EXISTS "audio_channels"              integer,
  ADD COLUMN IF NOT EXISTS "transcription_status"        text,
  ADD COLUMN IF NOT EXISTS "transcript_text"             text,
  ADD COLUMN IF NOT EXISTS "transcript_word_timestamps"  jsonb,
  ADD COLUMN IF NOT EXISTS "scene_count"                 integer,
  ADD COLUMN IF NOT EXISTS "scene_boundaries"            jsonb,
  ADD COLUMN IF NOT EXISTS "thumbnail_r2_key"            text,
  ADD COLUMN IF NOT EXISTS "preprocessed_at"             timestamptz;--> statement-breakpoint

-- ── Step 2: CHECK constraint on transcription_status ─────────────────────────
-- Guards against typos in application code. NULL is allowed (column is optional).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_transcription_status_check'
  ) THEN
    ALTER TABLE "assets"
      ADD CONSTRAINT "assets_transcription_status_check"
      CHECK (
        "transcription_status" IS NULL
        OR "transcription_status" IN ('pending', 'processing', 'complete', 'failed')
      );
  END IF;
END $$;
