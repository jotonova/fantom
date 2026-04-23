import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import pg from 'pg'
import type { HealthResponse, DbHealthResponse } from '@fantom/shared'

const { Pool } = pg

const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
})

const server = Fastify({ logger: true })

await server.register(cors, {
  origin: process.env['WEB_URL'] ?? '*',
})

server.get<{ Reply: HealthResponse }>('/health', async (_request, reply) => {
  return reply.send({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  })
})

server.get<{ Reply: DbHealthResponse }>('/db/health', async (_request, reply) => {
  const start = Date.now()
  let connected = false
  let latencyMs = 0

  try {
    await pool.query('SELECT 1')
    connected = true
    latencyMs = Date.now() - start
  } catch (err) {
    server.log.error(err, 'DB health check failed')
    latencyMs = Date.now() - start
  }

  return reply.send({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    db: {
      connected,
      latencyMs,
    },
  })
})

const port = Number(process.env['PORT'] ?? 3001)

const start = async () => {
  try {
    await server.listen({ port, host: '0.0.0.0' })
    server.log.info(`Server listening on port ${port}`)
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

process.on('SIGTERM', async () => {
  server.log.info('SIGTERM received — shutting down gracefully')
  await server.close()
  await pool.end()
  process.exit(0)
})

await start()
