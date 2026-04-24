import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema/index.js'

// DATABASE_URL must be set in the environment before this module is imported.
// Standalone scripts (migrate, seed) load dotenv themselves; apps/api loads it
// at startup before any @fantom/db imports are evaluated.
const connectionString = process.env['DATABASE_URL']
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Set it before importing @fantom/db.')
}

export const pool = new pg.Pool({ connectionString })

export const db = drizzle(pool, { schema })
export type Db = typeof db
