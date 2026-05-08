-- Alert deduplication table: prevents identical alerts from spamming within a 1-hour window.
-- dedupe_key is sha256(tenantId|kind|severity|subjectType).
-- prev_suppressed_count preserves the old count so the next email can report "N duplicates".
CREATE TABLE IF NOT EXISTS alert_dedupe (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dedupe_key           text        NOT NULL,
  last_sent_at         timestamptz NOT NULL,
  suppressed_count     integer     NOT NULL DEFAULT 0,
  prev_suppressed_count integer    NOT NULL DEFAULT 0,
  CONSTRAINT alert_dedupe_tenant_key UNIQUE (tenant_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS alert_dedupe_last_sent_at_idx ON alert_dedupe (last_sent_at);
