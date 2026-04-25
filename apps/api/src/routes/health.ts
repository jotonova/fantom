import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db } from '@fantom/db'
import { sql } from 'drizzle-orm'
import { Redis } from 'ioredis'

// ── Routes ────────────────────────────────────────────────────────────────────

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /health/live ───────────────────────────────────────────────────────────
  // Returns 200 if the process is responsive. No dependencies checked.
  // Used by Render's liveness probe (restarts on non-200).
  fastify.get('/health/live', async (_request, reply) => {
    return reply.send({ status: 'live', timestamp: new Date().toISOString() })
  })

  // GET /health/ready ──────────────────────────────────────────────────────────
  // Returns 200 if the API is ready to serve traffic (DB + Redis reachable).
  // Returns 503 if any dependency is unavailable.
  // Used by Render's readiness probe (stops routing traffic on non-200).
  fastify.get('/health/ready', async (_request, reply) => {
    const checks: { db: boolean; redis: boolean } = { db: false, redis: false }

    // DB check
    try {
      await db.execute(sql`SELECT 1`)
      checks.db = true
    } catch (err) {
      fastify.log.error(err, 'health/ready: DB check failed')
    }

    // Redis check
    const redisUrl = process.env['REDIS_URL']
    if (redisUrl) {
      let redisClient: Redis | null = null
      try {
        redisClient = new Redis(redisUrl, {
          maxRetriesPerRequest: 1,
          connectTimeout: 3000,
          enableReadyCheck: false,
          lazyConnect: true,
        })
        await redisClient.connect()
        await redisClient.ping()
        checks.redis = true
      } catch (err) {
        fastify.log.error(err, 'health/ready: Redis check failed')
      } finally {
        redisClient?.disconnect()
      }
    }

    const healthy = checks.db && checks.redis
    return reply
      .code(healthy ? 200 : 503)
      .send({ status: healthy ? 'ready' : 'degraded', checks, timestamp: new Date().toISOString() })
  })
}

export default fp(healthRoutes, {
  name: 'health-routes',
  fastify: '4.x',
})
