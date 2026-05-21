-- 0032_density
-- Adds density column to shorts_briefs for scene-aware re-cut frequency (1B.9.1).
-- Values: 'low' | 'medium' | 'high'. Defaults to 'medium' so existing briefs
-- get current-pipeline behaviour unchanged.

ALTER TABLE shorts_briefs ADD COLUMN IF NOT EXISTS density text DEFAULT 'medium';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE shorts_briefs ADD CONSTRAINT shorts_briefs_density_check CHECK (density IN ('low', 'medium', 'high'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
