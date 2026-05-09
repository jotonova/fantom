-- Phase 1B.2: Add creative-brief content columns to shorts_briefs.
-- These are separate columns (not buried in main_scenes jsonb) because workers
-- will reference them directly, and dedicated columns are simpler to query.

ALTER TABLE "shorts_briefs"
  ADD COLUMN IF NOT EXISTS "opening"  text,
  ADD COLUMN IF NOT EXISTS "closing"  text,
  ADD COLUMN IF NOT EXISTS "pacing"   text
    CONSTRAINT shorts_briefs_pacing_check CHECK (pacing IN ('fast', 'medium', 'slow'));
