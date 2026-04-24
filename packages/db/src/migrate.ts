import 'dotenv/config'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../migrations')

const pool = new pg.Pool({
  connectionString: process.env['DATABASE_URL'],
})

const db = drizzle(pool)

try {
  await migrate(db, { migrationsFolder })
  console.log('✓ Migrations applied successfully')
} finally {
  await pool.end()
}
