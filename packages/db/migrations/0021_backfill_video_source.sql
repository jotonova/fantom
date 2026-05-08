-- Backfill metadata.source for all existing kind='video' rows.
-- Rows with preprocessed_at set → user uploads (1A preprocessing ran on them).
-- Rows without preprocessed_at → older generated outputs from render workers.
UPDATE assets
SET metadata = COALESCE(metadata, '{}'::jsonb) ||
               jsonb_build_object(
                 'source',
                 CASE WHEN preprocessed_at IS NOT NULL THEN 'upload'
                      ELSE 'rendered'
                 END
               )
WHERE kind = 'video'
  AND (metadata->>'source') IS NULL;
