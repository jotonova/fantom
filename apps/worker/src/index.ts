import 'dotenv/config'
import { db, pool } from '@fantom/db'
import { getWorker, JobKind } from '@fantom/jobs'
import type { QueuePayload } from '@fantom/jobs'
import type { Job } from 'bullmq'
import { sql } from 'drizzle-orm'
import { RenderBus, CancelledError } from '@fantom/render-bus'
import type { RenderContext } from '@fantom/render-bus'
import { FfmpegProvider } from './providers/ffmpegProvider.js'
import { RemotionProvider } from './providers/remotionProvider.js'
import { CapCutProvider } from './providers/capcutProvider.js'
import {
  getJobRow,
  patchJob,
  setProgress,
  getPreferredProvider,
  createAssetRecord,
  getTenantSlug,
} from './lib/db.js'
import { getPublicUrl } from '@fantom/storage'

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

// ── Render bus setup ──────────────────────────────────────────────────────────
// Providers are checked in registration order when falling back.
// FfmpegProvider is first and handles all current job kinds.

const bus = new RenderBus()
  .register(new FfmpegProvider())
  .register(new RemotionProvider())
  .register(new CapCutProvider())

console.log(`fantom-worker: render bus registered providers: ${bus.registeredNames().join(', ')}`)

// ── Job dispatcher ────────────────────────────────────────────────────────────

async function dispatch(bullJob: Job<QueuePayload>): Promise<void> {
  const { jobId, tenantId } = bullJob.data

  // Read job from DB
  const job = await getJobRow(jobId, tenantId)
  if (!job) throw new Error(`Job ${jobId} not found in DB`)

  const kind = job.kind

  // Mark as processing
  await patchJob(jobId, tenantId, { status: 'processing', startedAt: new Date() })

  // Resolve provider — check tenant preference first
  const preferred = await getPreferredProvider(tenantId).catch(() => undefined)
  const provider = bus.resolve(kind, preferred)

  console.log(`fantom-worker: job ${jobId} (${kind}) → provider: ${provider.name}`)

  // Build render context
  const tenantSlug = await getTenantSlug(tenantId)

  const context: RenderContext = {
    jobId,
    tenantId,
    tenantSlug,
    input: job.input as Record<string, unknown>,
    onProgress: (pct) => {
      setProgress(jobId, tenantId, pct).catch(console.error)
    },
    checkCancelled: async () => {
      const row = await getJobRow(jobId, tenantId)
      if (row?.status === 'cancelled') throw new CancelledError()
    },
    log: (msg) => {
      console.log(`[job:${jobId}] ${msg}`)
    },
  }

  try {
    const result = await provider.render(context)

    // Create output asset record
    const videoAsset = await createAssetRecord({
      tenantId,
      kind: 'video',
      r2Key: result.r2Key,
      originalFilename: result.originalFilename,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      durationSeconds: result.durationSeconds,
      width: result.width,
      height: result.height,
    })

    console.log(
      `[job:${jobId}] video asset created ${videoAsset.id} — ${getPublicUrl(result.r2Key)}`,
    )

    // Mark job complete
    await patchJob(jobId, tenantId, {
      status: 'completed',
      progress: 100,
      outputAssetId: videoAsset.id,
      completedAt: new Date(),
    })
  } catch (err) {
    if (err instanceof CancelledError) {
      // DB already shows 'cancelled' (set by the API). Resolve cleanly —
      // BullMQ marks the job completed, no retry scheduled.
      console.log(`[job:cancelled] bull job ${bullJob.id} (${kind}) — not retrying`)
      return
    }

    // Error handling with retry logic
    const errMessage = err instanceof Error ? err.message : String(err)
    const errStack = err instanceof Error ? (err.stack ?? null) : null

    const maxRetries = job.maxRetries ?? 2
    const newRetries = bullJob.attemptsMade + 1

    if (newRetries < maxRetries) {
      await patchJob(jobId, tenantId, {
        status: 'queued',
        retries: newRetries,
        errorMessage: errMessage,
      }).catch(console.error)
    } else {
      await patchJob(jobId, tenantId, {
        status: 'failed',
        retries: newRetries,
        errorMessage: errMessage,
        errorStack: errStack,
      }).catch(console.error)
    }

    throw err // Let BullMQ handle its own retry/fail tracking
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
