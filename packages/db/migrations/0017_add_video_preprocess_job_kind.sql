-- 1A.2: Add video_preprocess to job_kind enum
-- ALTER TYPE ADD VALUE is DDL that auto-commits in PostgreSQL — it must be the
-- only statement in this migration file so the custom migrator runs it in
-- autocommit mode and the new value is visible to subsequent migrations.
-- IF NOT EXISTS is a PG 9.3+ guard — safe to re-run.
ALTER TYPE "job_kind" ADD VALUE IF NOT EXISTS 'video_preprocess' AFTER 'render_short_video';
