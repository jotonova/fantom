-- One-time data fix: mark the M1.P2.a smoke test shorts_job as failed.
-- The row was left in status='rendering' after the voice/handler bugs were
-- discovered. Safe to re-run (UPDATE WHERE id= is idempotent).

UPDATE "shorts_jobs"
SET
  "status"        = 'failed',
  "error_message" = 'Cancelled - render handler bugs (M1.P2.a smoke test)',
  "updated_at"    = now()
WHERE "id" = '48c882fc-0ff5-4a45-ab84-0fe2ef45e5e2';
