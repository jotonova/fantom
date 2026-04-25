import 'dotenv/config'
import { db, pool } from '@fantom/db'
import { getWorker, JobKind } from '@fantom/jobs'
import type { QueuePayload } from '@fantom/jobs'
import type { Job } from 'bullmq'
import { sql } from 'drizzle-orm'
import { renderTestVideoHandler, CancelledError } from './handlers/renderTestVideo.js'

// ── Env validation ────────────────────────────────────────────────────────────

const required = ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET']
const missing = required.filter((k) => !process.env[k])
if (missing.length > 0) {
  console.error(`FATAL: missing required env vars: ${missing.join(', ')}`)
  process.exit(1)
}

// ── DB connectivity check ─────────────────────────────────────────────────────

try {
  await db.execute(sql`SELECT 1`)
  console.log('fantom-worker: database connected')
} catch (err) {
  console.error('fantom-worker: database connection failed', err)
  process.exit(1)
}

// ── Job dispatcher ────────────────────────────────────────────────────────────

async function dispatch(bullJob: Job<QueuePayload>): Promise<void> {
  const { jobId, tenantId } = bullJob.data

  try {
    switch (bullJob.name) {
      case JobKind.RENDER_TEST_VIDEO:
        await renderTestVideoHandler({ jobId, tenantId, attemptsMade: bullJob.attemptsMade })
        break
      default:
        throw new Error(`Job kind '${bullJob.name}' is not yet implemented`)
    }
  } catch (err) {
    if (err instanceof CancelledError) {
      // DB already shows 'cancelled'. Resolve cleanly so BullMQ marks the job
      // completed rather than failed, and doesn't schedule a retry.
      console.log(`[job:cancelled] bull job ${bullJob.id} (${bullJob.name}) — not retrying`)
      return
    }
    throw err
  }
}

// ── Worker ────────────────────────────────────────────────────────────────────

const worker = getWorker(dispatch)

worker.on('active', (job) => {
  console.log(`fantom-worker: job ${job.id} (${job.name}) started`)
})

worker.on('completed', (job) => {
  console.log(`fantom-worker: job ${job.id} (${job.name}) completed`)
})

worker.on('failed', (job, err) => {
  console.error(`fantom-worker: job ${job?.id} (${job?.name}) failed — ${err.message}`)
})

worker.on('error', (err) => {
  console.error('fantom-worker: worker error', err)
})

console.log('fantom-worker listening on queue fantom-render, ready')

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`fantom-worker: ${signal} received — shutting down gracefully`)
  await worker.close()
  await pool.end()
  console.log('fantom-worker: shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
