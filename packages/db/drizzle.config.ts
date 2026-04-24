import { defineConfig } from 'drizzle-kit'
import 'dotenv/config'

export default defineConfig({
  dialect: 'postgresql',
  schema: './dist/schema/index.js',
  out: './migrations',
  dbCredentials: {
    // Use MIGRATE_DATABASE_URL (owner role) for schema introspection and generation.
    // Falls back to DATABASE_URL for local dev before app_user is set up.
    url: process.env['MIGRATE_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '',
  },
  verbose: true,
  strict: true,
})
