import { createServer, type Server } from 'node:http'
import { db } from '@fantom/db'
import { sql } from 'drizzle-orm'
import { Redis } from 'ioredis'

/**
 * Minimal HTTP health server for the Render Background Worker.
 * Background Workers don't have an HTTP listener by default, but Render's
 * health check system needs an endpoint to confirm liveness.
 *
 * Listens on PORT_HEALTH (default 9999).
 * Routes:
 *   GET /health/live  — always 200 (process responsive check)
 *   GET /health/ready — checks DB + Redis, returns 200 or 503
 */
export function startHealthServer(): Server {
  const port = parseInt(process.env['PORT_HEALTH'] ?? '9999', 10)

  const server = createServer((req, res) => {
    const url = req.url ?? ''

    if (url === '/health/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'live', timestamp: new Date().toISOString() }))
      return
    }

    if (url === '/health/ready') {
      void handleReady(res)
      return
    }

    res.writeHead(404)
    res.end()
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`fantom-worker: health server listening on port ${port}`)
  })

  server.on('error', (err) => {
    console.error('fantom-worker: health server error:', err)
  })

  return server
}

async function handleReady(res: import('node:http').ServerResponse): Promise<void> {
  const checks: { db: boolean; redis: boolean } = { db: false, redis: false }

  // DB check
  try {
    await db.execute(sql`SELECT 1`)
    checks.db = true
  } catch (err) {
    console.error('fantom-worker health: DB check failed:', err)
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
      console.error('fantom-worker health: Redis check failed:', err)
    } finally {
      redisClient?.disconnect()
    }
  }

  const healthy = checks.db && checks.redis
  const body = JSON.stringify({
    status: healthy ? 'ready' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  })

  res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' })
  res.end(body)
}
