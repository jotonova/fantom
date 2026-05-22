-- 0033_use_broll
-- Adds use_broll boolean to shorts_briefs for B-roll pool assembly (1B.9.2b).
-- Default FALSE preserves existing behaviour: only source_asset_ids are used.
-- When TRUE, the assembly engine weaves segments from tenant-library clips that
-- are NOT in source_asset_ids between the hero-clip segments.

ALTER TABLE shorts_briefs ADD COLUMN IF NOT EXISTS use_broll boolean NOT NULL DEFAULT false;
