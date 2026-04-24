import { defineConfig } from 'drizzle-kit'
import 'dotenv/config'

export default defineConfig({
  dialect: 'postgresql',
  schema: './dist/schema/index.js',
  out: './migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
  verbose: true,
  strict: true,
})
