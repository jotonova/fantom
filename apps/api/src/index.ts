import 'dotenv/config'
import { db, pool } from '@fantom/db'
import { sql } from 'drizzle-orm'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyJwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import type { HealthResponse, DbHealthResponse } from '@fantom/shared'
import authPlugin from './plugins/auth.js'
import tenantContextPlugin from './plugins/tenant-context.js'
import authRoutes from './routes/auth.js'
import tenantRoutes from './routes/tenants.js'
import assetRoutes from './routes/assets.js'
import voiceRoutes from './routes/voices.js'
import jobRoutes from './routes/jobs.js'

// Fail fast in production if JWT_SECRET is not set.
if (process.env['NODE_ENV'] === 'production' && !process.env['JWT_SECRET']) {
  console.error('FATAL: JWT_SECRET env var is required in production. Exiting.')
  process.exit(1)
}

const server = Fastify({ logger: true })

// ── CORS ──────────────────────────────────────────────────────────────────────

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

// ── JWT ───────────────────────────────────────────────────────────────────────

await server.register(fastifyJwt, {
  secret: process.env['JWT_SECRET'] ?? 'dev-secret-do-not-use-in-production',
})

// ── Rate limiting (opt-in per route) ─────────────────────────────────────────

await server.register(rateLimit, { global: false })

// ── Plugins (order matters: auth → tenant-context → routes) ──────────────────

// 1. Auth: parses Bearer token → sets request.user + request.tenantId from JWT.
await server.register(authPlugin)

// 2. Tenant-context: falls back to X-Tenant-Slug header only if JWT didn't
//    already set tenantId.
await server.register(tenantContextPlugin)

// ── Routes ────────────────────────────────────────────────────────────────────

await server.register(authRoutes)
await server.register(tenantRoutes)
await server.register(assetRoutes)
await server.register(voiceRoutes)
await server.register(jobRoutes)

// ── Health endpoints ──────────────────────────────────────────────────────────

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
        const result = await db.execute(
          sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
        )
        const row = result.rows[0]
        if (row && typeof row['count'] === 'number') {
          migrationsApplied = row['count']
        }
      } catch {
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

// ── Start ─────────────────────────────────────────────────────────────────────

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
