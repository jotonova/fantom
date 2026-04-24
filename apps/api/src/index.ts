import 'dotenv/config'
import { db, pool } from '@fantom/db'
import { sql } from 'drizzle-orm'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { HealthResponse, DbHealthResponse } from '@fantom/shared'
import tenantContextPlugin from './plugins/tenant-context.js'
import tenantRoutes from './routes/tenants.js'

const server = Fastify({ logger: true })

// Build allowed origins list from WEB_URLS (comma-separated) or fall back to WEB_URL.
// In non-production, http://localhost:3000 is always included.
const rawOrigins = process.env['WEB_URLS'] ?? process.env['WEB_URL'] ?? ''
const allowedOrigins = new Set(
  rawOrigins
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
)
if (process.env['NODE_ENV'] !== 'production') {
  allowedOrigins.add('http://localhost:3000')
}

await server.register(cors, {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true)
    callback(new Error(`CORS: origin ${origin} not allowed`), false)
  },
})

await server.register(tenantContextPlugin)
await server.register(tenantRoutes)

server.get<{ Reply: HealthResponse }>('/health', async (_request, reply) => {
  return reply.send({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  })
})

server.get<{ Reply: DbHealthResponse & { migrationsApplied: number } }>(
  '/db/health',
  async (_request, reply) => {
    const start = Date.now()
    let connected = false
    let latencyMs = 0
    let migrationsApplied = 0

    try {
      await db.execute(sql`SELECT 1`)
      connected = true
      latencyMs = Date.now() - start
    } catch (err) {
      server.log.error(err, 'DB health check failed')
      latencyMs = Date.now() - start
    }

    if (connected) {
      try {
        // drizzle-kit stores migration history in drizzle.__drizzle_migrations
        const result = await db.execute(
          sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
        )
        const row = result.rows[0]
        if (row && typeof row['count'] === 'number') {
          migrationsApplied = row['count']
        }
      } catch {
        // Table doesn't exist yet — migrations have not been run
        migrationsApplied = 0
      }
    }

    return reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      db: { connected, latencyMs },
      migrationsApplied,
    })
  },
)

const port = Number(process.env['PORT'] ?? 3001)

process.on('SIGTERM', async () => {
  server.log.info('SIGTERM received — shutting down gracefully')
  await server.close()
  await pool.end()
  process.exit(0)
})

try {
  await server.listen({ port, host: '0.0.0.0' })
  server.log.info(`Server listening on port ${port}`)
} catch (err) {
  server.log.error(err)
  process.exit(1)
}
