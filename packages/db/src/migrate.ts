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
// We do NOT use Drizzle's built-in migrate() here because it wraps ALL pending
// migrations in a single transaction. That causes PostgreSQL error 55P04 when
// one migration does ALTER TYPE ... ADD VALUE and a subsequent migration in the
// same transaction references that new enum value — the value isn't visible
// within the transaction that added it.
//
// This migrator:
// 1. Determines pending migrations using Drizzle's own skip logic:
//    compare entry.when against max(created_at) in __drizzle_migrations.
//    This avoids any hash-format mismatch with Drizzle's historical records.
// 2. Runs each pending migration on its own pooled client in autocommit mode
//    (no explicit BEGIN/COMMIT). Each SQL statement is its own implicit PG
//    transaction, so ALTER TYPE ADD VALUE commits immediately and the new enum
//    value is visible to every subsequent statement, including those in the
//    next migration file.
// 3. Records applied migrations with created_at = entry.when (the journal
//    timestamp) — exactly what Drizzle's own migrate() stores — so the table
//    remains fully compatible with Drizzle's skip logic on future runs.

const pool = new pg.Pool({ connectionString })

// Ensure the Drizzle migrations tracking table exists (idempotent).
// Drizzle creates this on first run; in production it already exists for 0000-0007.
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

// Find the highest applied migration timestamp.
// Drizzle stores entry.when as created_at, so this tells us the last applied migration.
const checkLatest = await pool.connect()
let lastAppliedWhen = 0
try {
  const { rows } = await checkLatest.query<{ created_at: string }>(
    'SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1',
  )
  // pg returns bigint columns as strings to avoid JS precision loss — convert explicitly.
  if (rows[0]) {
    lastAppliedWhen = Number(rows[0].created_at)
  }
} finally {
  checkLatest.release()
}

// Read journal.
const journal = JSON.parse(
  readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf-8'),
) as Journal

let applied = 0
let skipped = 0

for (const entry of journal.entries) {
  // Drizzle's skip condition: any migration whose when <= lastAppliedWhen is already applied.
  if (entry.when <= lastAppliedWhen) {
    console.log(`  skip  ${entry.tag}`)
    skipped++
    continue
  }

  const sqlPath = join(migrationsFolder, `${entry.tag}.sql`)
  const sql = readFileSync(sqlPath, 'utf-8')
  // Drizzle hashes raw file content with SHA-256 — replicate for compatible record storage.
  const hash = createHash('sha256').update(sql).digest('hex')

  // Run this migration on a dedicated client in autocommit mode.
  // NO explicit BEGIN/COMMIT — each statement gets its own implicit PG transaction.
  // Critical for 0008: ALTER TYPE ADD VALUE commits immediately, so 0009 can
  // reference 'platform_admin' without hitting error 55P04.
  const client = await pool.connect()
  try {
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)

    for (const statement of statements) {
      await client.query(statement)
    }

    // Record as applied. Use entry.when as created_at — this is exactly what
    // Drizzle's migrate() stores, ensuring future drizzle migrate() calls
    // correctly skip this migration.
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

if (applied === 0) {
  console.log('✓ No pending migrations.')
} else {
  console.log(`✓ ${applied} migration(s) applied, ${skipped} skipped.`)
}
