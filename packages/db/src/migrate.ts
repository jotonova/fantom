import 'dotenv/config'
import pg from 'pg'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ── Config ────────────────────────────────────────────────────────────────────

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../migrations')

// MIGRATE_DATABASE_URL must be the owner-role connection string (BYPASSRLS).
// After app_user is provisioned (migration 0003), DATABASE_URL will be the
// restricted app_user URL, which lacks DDL privileges required by migrations.
const connectionString = process.env['MIGRATE_DATABASE_URL'] ?? process.env['DATABASE_URL']

if (!connectionString) {
  console.error('ERROR: MIGRATE_DATABASE_URL or DATABASE_URL must be set to run migrations.')
  process.exit(1)
}

// ── Journal types ─────────────────────────────────────────────────────────────

interface JournalEntry {
  idx: number
  tag: string
  when: number
  breakpoints: boolean
}

interface Journal {
  entries: JournalEntry[]
}

// ── Custom migrator ───────────────────────────────────────────────────────────
//
// We do NOT use Drizzle's built-in migrate() because it wraps ALL pending
// migrations in a single transaction. That causes PostgreSQL error 55P04 when
// one migration does ALTER TYPE ... ADD VALUE and a subsequent migration in the
// same transaction references that new enum value.
//
// This migrator runs each pending migration on its own pooled client in
// autocommit mode (no explicit BEGIN/COMMIT). Each SQL statement is its own
// implicit PG transaction, so ALTER TYPE ADD VALUE commits immediately and is
// visible to all subsequent queries including those in the next migration file.
//
// Skip logic replicates Drizzle's: a migration is pending if its journal `when`
// timestamp is greater than max(created_at) in __drizzle_migrations. Applied
// migrations are recorded with created_at = entry.when so Drizzle's own tooling
// (drizzle-kit studio, etc.) remains compatible.
//
// Backfill: __drizzle_migrations was never populated by Drizzle's migrate() in
// this project's history (the original deploy may have applied DDL via a
// different path, or a failed transaction rolled back the tracking inserts while
// leaving the DDL committed — PG DDL is only transactional within the same tx).
// We detect this "orphaned schema" state and backfill the tracking table before
// running pending migrations.

const pool = new pg.Pool({ connectionString })

// ── Step 1: Ensure tracking table exists ─────────────────────────────────────

const init = await pool.connect()
try {
  await init.query(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id         SERIAL PRIMARY KEY,
      hash       text NOT NULL,
      created_at bigint
    )
  `)
} finally {
  init.release()
}

// ── Step 2: Read journal ──────────────────────────────────────────────────────

const journal = JSON.parse(
  readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf-8'),
) as Journal

// ── Step 3: Backfill orphaned-schema detection ────────────────────────────────
//
// If __drizzle_migrations is empty but the `distributions` table exists, the
// schema through 0007_distributions has already been physically applied without
// being tracked. Backfill those entries so the skip logic works correctly and
// every subsequent deploy sees the right baseline.

const orphanClient = await pool.connect()
let lastAppliedWhen = 0
try {
  const { rows: countRows } = await orphanClient.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM "__drizzle_migrations"',
  )
  const isEmpty = Number(countRows[0]?.count ?? 0) === 0

  if (isEmpty) {
    const { rows: regRows } = await orphanClient.query<{ tbl: string | null }>(
      "SELECT to_regclass('public.distributions') AS tbl",
    )
    const schemaExists = regRows[0]?.tbl !== null

    if (schemaExists) {
      // 0007_distributions is the last migration that existed before F9.
      // Its journal `when` timestamp is the baseline for all pre-existing migrations.
      const LAST_PREEXISTING_WHEN = 1777400000000 // 0007_distributions
      const toBackfill = journal.entries.filter((e) => e.when <= LAST_PREEXISTING_WHEN)

      console.log(
        `Detected pre-existing schema with empty tracking table. Backfilling ${toBackfill.length} migrations (0000-0007).`,
      )

      for (const entry of toBackfill) {
        const sqlPath = join(migrationsFolder, `${entry.tag}.sql`)
        const sql = readFileSync(sqlPath, 'utf-8')
        const hash = createHash('sha256').update(sql).digest('hex')
        await orphanClient.query(
          'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
          [hash, entry.when],
        )
      }

      lastAppliedWhen = LAST_PREEXISTING_WHEN
      console.log(`Backfilled. Proceeding with pending migrations.`)
    }
  } else {
    // Normal path: read the highest recorded timestamp.
    const { rows: maxRows } = await orphanClient.query<{ created_at: string }>(
      'SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1',
    )
    // pg returns bigint as string to avoid JS precision loss — convert explicitly.
    if (maxRows[0]) {
      lastAppliedWhen = Number(maxRows[0].created_at)
    }
  }
} finally {
  orphanClient.release()
}

// ── Step 4: Apply pending migrations ─────────────────────────────────────────

let applied = 0
let skipped = 0

for (const entry of journal.entries) {
  if (entry.when <= lastAppliedWhen) {
    console.log(`  skip  ${entry.tag}`)
    skipped++
    continue
  }

  const sqlPath = join(migrationsFolder, `${entry.tag}.sql`)
  const sql = readFileSync(sqlPath, 'utf-8')
  const hash = createHash('sha256').update(sql).digest('hex')

  // Fresh client per migration, autocommit (no BEGIN/COMMIT).
  // Each statement is its own implicit PG transaction — critical so that
  // ALTER TYPE ADD VALUE in 0008 commits before 0009 references the new value.
  const client = await pool.connect()
  try {
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)

    for (const statement of statements) {
      await client.query(statement)
    }

    // Record with entry.when as created_at — matches Drizzle's storage format.
    await client.query(
      'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
      [hash, entry.when],
    )

    console.log(`  apply ${entry.tag}`)
    applied++
  } finally {
    client.release()
  }
}

await pool.end()

if (applied === 0 && skipped > 0) {
  console.log('✓ No pending migrations.')
} else {
  const backfilled = journal.entries.filter((e) => e.when <= lastAppliedWhen).length - skipped
  const backfilledNote = backfilled > 0 ? `, ${backfilled} backfilled` : ''
  console.log(`✓ ${applied} migration(s) applied, ${skipped} skipped${backfilledNote}.`)
}
