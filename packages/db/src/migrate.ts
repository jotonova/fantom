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
// This migrator runs each migration file on its own pooled client in autocommit
// mode (no explicit BEGIN/COMMIT). Each SQL statement is its own implicit
// transaction, so ALTER TYPE ADD VALUE commits immediately and is visible to
// every subsequent query, including those in the next migration file.
//
// Hash computation matches Drizzle's internal algorithm (SHA-256 of raw file
// content) so the __drizzle_migrations table stays compatible with `drizzle-kit`
// and any future use of the standard migrator.

const pool = new pg.Pool({ connectionString })

// Ensure the Drizzle migrations tracking table exists (idempotent).
const setup = await pool.connect()
try {
  await setup.query(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id      SERIAL PRIMARY KEY,
      hash    text NOT NULL,
      created_at bigint
    )
  `)
} finally {
  setup.release()
}

// Read journal.
const journal = JSON.parse(
  readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf-8'),
) as Journal

let applied = 0
let skipped = 0

for (const entry of journal.entries) {
  const sqlPath = join(migrationsFolder, `${entry.tag}.sql`)
  const sql = readFileSync(sqlPath, 'utf-8')

  // Drizzle hashes the raw file content with SHA-256.
  const hash = createHash('sha256').update(sql).digest('hex')

  // Check if already applied (use a short-lived client to avoid holding connections).
  const checkClient = await pool.connect()
  let alreadyApplied = false
  try {
    const { rows } = await checkClient.query<{ hash: string }>(
      'SELECT hash FROM "__drizzle_migrations" WHERE hash = $1 LIMIT 1',
      [hash],
    )
    alreadyApplied = rows.length > 0
  } finally {
    checkClient.release()
  }

  if (alreadyApplied) {
    console.log(`  skip  ${entry.tag}`)
    skipped++
    continue
  }

  // Run this migration on a dedicated client in autocommit mode.
  // Each statement executes in its own implicit PG transaction (no BEGIN/COMMIT).
  // This is the critical property: ALTER TYPE ADD VALUE in migration N commits
  // before any statement in migration N+1 runs, so the new enum value is visible.
  const client = await pool.connect()
  try {
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)

    for (const statement of statements) {
      await client.query(statement)
    }

    // Record as applied — same schema Drizzle uses.
    await client.query(
      'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
      [hash, Date.now()],
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
