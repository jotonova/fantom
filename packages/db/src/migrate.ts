import 'dotenv/config'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../migrations')

// MIGRATE_DATABASE_URL must be the owner-role connection string (BYPASSRLS).
// After app_user is provisioned (migration 0003), DATABASE_URL will be the
// restricted app_user URL, which lacks DDL privileges required by migrations.
const connectionString = process.env['MIGRATE_DATABASE_URL'] ?? process.env['DATABASE_URL']

if (!connectionString) {
  console.error('ERROR: MIGRATE_DATABASE_URL or DATABASE_URL must be set to run migrations.')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString })
const db = drizzle(pool)

try {
  await migrate(db, { migrationsFolder })
  console.log('✓ Migrations applied successfully')
} finally {
  await pool.end()
}
