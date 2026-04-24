// Re-export schema types and the singleton Drizzle client.
// Import @fantom/db only from apps that have already loaded dotenv/config,
// as the pool is created at module evaluation time.
export * from './schema/index.js'
export { db, pool } from './client.js'
export type { Db } from './client.js'
