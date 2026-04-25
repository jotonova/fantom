import 'dotenv/config'
import { startHealthServer } from './health.js'
import { db, pool } from '@fantom/db'
import { getWorker, getDistributeWorker, enqueueDistribution, JobKind } from '@fantom/jobs'
import type { QueuePayload, DistributePayload } from '@fantom/jobs'
import type { Job as BullJob } from 'bullmq'
import { sql } from 'drizzle-orm'
import { RenderBus, CancelledError as RenderCancelledError } from '@fantom/render-bus'
import type { RenderContext } from '@fantom/render-bus'
import {
  DistributionBus,
  CancelledError as DistributionCancelledError,
} from '@fantom/distribution-bus'
import type { DistributionContext } from '@fantom/distribution-bus'
import { logEvent } from '@fantom/observability'
import { FfmpegProvider } from './providers/ffmpegProvider.js'
import { RemotionProvider } from './providers/remotionProvider.js'
import { CapCutProvider } from './providers/capcutProvider.js'
import { WebhookDestination } from './destinations/webhookDestination.js'
import { WebhookRetryableError } from './destinations/webhookDestination.js'
import { YouTubeDestination } from './destinations/youtubeDestination.js'
import { FacebookDestination } from './destinations/facebookDestination.js'
import { InstagramDestination } from './destinations/instagramDestination.js'
import { MlsDestination } from './destinations/mlsDestination.js'
import { getPublicUrl } from '@fantom/storage'
import {
  getJobRow,
  patchJob,
  setProgress,
  getPreferredProvider,
  createAssetRecord,
  getTenantSlug,
  getAutoPublishConfig,
  createDistributionRecord,
  getDistributionRow,
  patchDistribution,
  getAssetRow,
} from './lib/db.js'
import type { DestinationKind } from '@fantom/distribution-bus'

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

// ── Render bus ────────────────────────────────────────────────────────────────

const renderBus = new RenderBus()
  .register(new FfmpegProvider())
  .register(new RemotionProvider())
  .register(new CapCutProvider())

console.log(`fantom-worker: render bus providers: ${renderBus.registeredNames().join(', ')}`)

// ── Distribution bus ──────────────────────────────────────────────────────────

const distributionBus = new DistributionBus()
  .register(new WebhookDestination())
  .register(new YouTubeDestination())
  .register(new FacebookDestination())
  .register(new InstagramDestination())
  .register(new MlsDestination())

console.log(
  `fantom-worker: distribution bus providers: ${distributionBus.registeredNames().join(', ')}`,
)

// ── Auto-publish trigger ──────────────────────────────────────────────────────
// Called after a render job's output asset is created, before status='completed'.
// Inserts distribution rows + enqueues to fantom-distribute for each matching rule.
// Failures are logged but do NOT fail the render job.

async function triggerAutoPublish(opts: {
  tenantId: string
  jobId: string
  jobKind: string
  assetId: string
}): Promise<void> {
  const { tenantId, jobId, jobKind, assetId } = opts

  let rules
  try {
    rules = await getAutoPublishConfig(tenantId)
  } catch (err) {
    console.error(`[job:${jobId}] auto-publish config read failed:`, err)
    return
  }

  const matching = rules.filter(
    (r) => !r.on_kinds || r.on_kinds.includes(jobKind),
  )

  if (matching.length === 0) return

  console.log(`[job:${jobId}] auto-publish: ${matching.length} rule(s) matched`)

  for (const rule of matching) {
    try {
      const dist = await createDistributionRecord({
        tenantId,
        jobId,
        assetId,
        destinationKind: rule.kind,
        config: rule.config,
        createdByUserId: null,
      })

      await enqueueDistribution({
        distributionId: dist.id,
        tenantId,
        kind: rule.kind,
      })

      // Mark as queued in DB
      await patchDistribution(dist.id, tenantId, { status: 'queued' })

      console.log(`[job:${jobId}] auto-publish: enqueued distribution ${dist.id} → ${rule.kind}`)
    } catch (err) {
      console.error(`[job:${jobId}] auto-publish: failed to enqueue ${rule.kind}:`, err)
      // Continue with remaining rules — don't abort
    }
  }
}

// ── Render dispatcher ─────────────────────────────────────────────────────────

async function dispatchRender(bullJob: BullJob<QueuePayload>): Promise<void> {
  const { jobId, tenantId } = bullJob.data

  const job = await getJobRow(jobId, tenantId)
  if (!job) throw new Error(`Job ${jobId} not found in DB`)

  const kind = job.kind

  await patchJob(jobId, tenantId, { status: 'processing', startedAt: new Date() })

  logEvent({
    tenantId,
    kind: 'job.started',
    severity: 'info',
    subjectType: 'job',
    subjectId: jobId,
    metadata: { jobKind: kind },
  })

  const preferred = await getPreferredProvider(tenantId).catch(() => undefined)
  const provider = renderBus.resolve(kind, preferred)

  console.log(`fantom-worker: render job ${jobId} (${kind}) → provider: ${provider.name}`)

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
      if (row?.status === 'cancelled') throw new RenderCancelledError()
    },
    log: (msg) => {
      console.log(`[job:${jobId}] ${msg}`)
    },
  }

  try {
    const result = await provider.render(context)

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

    // Auto-publish trigger — must happen BEFORE status='completed' so any
    // downstream system that polls on completed sees distributions already queued.
    await triggerAutoPublish({
      tenantId,
      jobId,
      jobKind: kind,
      assetId: videoAsset.id,
    })

    await patchJob(jobId, tenantId, {
      status: 'completed',
      progress: 100,
      outputAssetId: videoAsset.id,
      completedAt: new Date(),
    })

    logEvent({
      tenantId,
      kind: 'job.completed',
      severity: 'info',
      subjectType: 'job',
      subjectId: jobId,
      metadata: {
        jobKind: kind,
        provider: provider.name,
        outputAssetId: videoAsset.id,
      },
    })
  } catch (err) {
    if (err instanceof RenderCancelledError) {
      console.log(`[job:cancelled] bull job ${bullJob.id} (${kind}) — not retrying`)
      return
    }

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
      logEvent({
        tenantId,
        kind: 'job.failed',
        severity: 'error',
        subjectType: 'job',
        subjectId: jobId,
        metadata: { jobKind: kind, provider: provider.name, retries: newRetries },
        errorMessage: errMessage,
        errorStack: errStack,
      })
    }

    throw err
  }
}

// ── Distribution dispatcher ───────────────────────────────────────────────────

async function dispatchDistribution(bullJob: BullJob<DistributePayload>): Promise<void> {
  const { distributionId, tenantId } = bullJob.data

  const dist = await getDistributionRow(distributionId, tenantId)
  if (!dist) throw new Error(`Distribution ${distributionId} not found in DB`)

  const kind = dist.destinationKind as DestinationKind

  await patchDistribution(distributionId, tenantId, {
    status: 'processing',
    startedAt: new Date(),
  })

  logEvent({
    tenantId,
    kind: 'distribution.attempted',
    severity: 'info',
    subjectType: 'distribution',
    subjectId: distributionId,
    metadata: { destinationKind: kind },
  })

  const provider = distributionBus.resolve(kind)
  console.log(
    `fantom-worker: distribution ${distributionId} (${kind}) → provider: ${provider.name}`,
  )

  // Load the output asset to build DistributionContext
  const asset = await getAssetRow(dist.assetId, tenantId)
  if (!asset) throw new Error(`Asset ${dist.assetId} not found for distribution ${distributionId}`)

  const context: DistributionContext = {
    distributionId,
    tenantId,
    jobId: dist.jobId,
    asset: {
      id: asset.id,
      publicUrl: getPublicUrl(asset.r2Key),
      width: asset.width,
      height: asset.height,
      durationSeconds: asset.durationSeconds != null ? Number(asset.durationSeconds) : null,
      sizeBytes: Number(asset.sizeBytes),
      mimeType: asset.mimeType,
      originalFilename: asset.originalFilename,
    },
    config: dist.config as Record<string, unknown>,
    onProgress: async (progress, label) => {
      await patchDistribution(distributionId, tenantId, {}).catch(console.error)
      console.log(`[dist:${distributionId}] progress ${progress}%${label ? ` — ${label}` : ''}`)
    },
    checkCancelled: async () => {
      const row = await getDistributionRow(distributionId, tenantId)
      if (row?.status === 'cancelled') throw new DistributionCancelledError()
    },
    log: (msg, data) => {
      const extra = data ? ` ${JSON.stringify(data)}` : ''
      console.log(`[dist:${distributionId}] ${msg}${extra}`)
    },
  }

  // Call lifecycle hooks if defined
  await provider.onStart?.(context)

  try {
    const result = await provider.publish(context)

    await provider.onComplete?.(context, result)

    await patchDistribution(distributionId, tenantId, {
      status: 'completed',
      externalId: result.externalId ?? null,
      externalUrl: result.externalUrl ?? null,
      responsePayload: result.responsePayload ?? null,
      completedAt: new Date(),
    })

    logEvent({
      tenantId,
      kind: 'distribution.completed',
      severity: 'info',
      subjectType: 'distribution',
      subjectId: distributionId,
      metadata: {
        destinationKind: kind,
        externalId: result.externalId ?? null,
        externalUrl: result.externalUrl ?? null,
      },
    })
    console.log(`[dist:${distributionId}] completed → ${kind}`)
  } catch (err) {
    await provider.onError?.(context, err instanceof Error ? err : new Error(String(err)))

    if (err instanceof DistributionCancelledError) {
      console.log(`[dist:cancelled] distribution ${distributionId} — not retrying`)
      return
    }

    const errMessage = err instanceof Error ? err.message : String(err)
    const errStack = err instanceof Error ? (err.stack ?? null) : null

    const maxRetries = dist.maxRetries ?? 3
    const newRetries = bullJob.attemptsMade + 1

    // WebhookRetryableError and generic errors are retried.
    // Non-retryable webhook errors (4xx) are marked failed immediately.
    const isRetryable =
      err instanceof WebhookRetryableError ||
      (!(err instanceof Error) || !errMessage.includes('not retrying'))

    if (isRetryable && newRetries < maxRetries) {
      await patchDistribution(distributionId, tenantId, {
        status: 'queued',
        retries: newRetries,
        errorMessage: errMessage,
      }).catch(console.error)
      throw err // Let BullMQ schedule the retry
    } else {
      await patchDistribution(distributionId, tenantId, {
        status: 'failed',
        retries: newRetries,
        errorMessage: errMessage,
        errorStack: errStack,
      }).catch(console.error)
      logEvent({
        tenantId,
        kind: 'distribution.failed',
        severity: 'error',
        subjectType: 'distribution',
        subjectId: distributionId,
        metadata: { destinationKind: kind, retries: newRetries },
        errorMessage: errMessage,
        errorStack: errStack,
      })
      throw err
    }
  }
}

// ── BullMQ workers ────────────────────────────────────────────────────────────

const renderWorker = getWorker(dispatchRender)
const distributeWorker = getDistributeWorker(dispatchDistribution)

for (const [label, w] of [
  ['render', renderWorker],
  ['distribute', distributeWorker],
] as const) {
  w.on('active', (job) => {
    console.log(`fantom-worker[${label}]: job ${job.id} (${job.name}) started`)
  })
  w.on('completed', (job) => {
    console.log(`fantom-worker[${label}]: job ${job.id} (${job.name}) completed`)
  })
  w.on('failed', (job, err) => {
    console.error(
      `fantom-worker[${label}]: job ${job?.id} (${job?.name}) failed — ${err.message}`,
    )
  })
  w.on('error', (err) => {
    console.error(`fantom-worker[${label}]: worker error`, err)
  })
}

// ── Health server ─────────────────────────────────────────────────────────────
// Render Background Workers have no default HTTP listener; this minimal server
// provides /health/live and /health/ready for the Render health check system.
const healthServer = startHealthServer()

console.log('fantom-worker listening on queues fantom-render + fantom-distribute, ready')

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`fantom-worker: ${signal} received — shutting down gracefully`)
  await renderWorker.close()
  await distributeWorker.close()
  await pool.end()
  healthServer.close()
  console.log('fantom-worker: shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
