import { Queue, Worker } from 'bullmq'
import type { Processor } from 'bullmq'
import { Redis } from 'ioredis'

// ── Constants ─────────────────────────────────────────────────────────────────

export const QUEUE_NAME = 'fantom-render'
export const DISTRIBUTE_QUEUE_NAME = 'fantom-distribute'

// ── Job kinds ─────────────────────────────────────────────────────────────────

export const JobKind = {
  RENDER_TEST_VIDEO: 'render_test_video',
  RENDER_LISTING_VIDEO: 'render_listing_video',
  RENDER_MARKET_UPDATE: 'render_market_update',
  RENDER_VIRTUAL_TOUR: 'render_virtual_tour',
  RENDER_FLIP_VIDEO: 'render_flip_video',
  RENDER_YOUTUBE_EDIT: 'render_youtube_edit',
  RENDER_SHORT_VIDEO: 'render_short_video',
} as const

export type JobKindValue = (typeof JobKind)[keyof typeof JobKind]

// ── BullMQ payloads ───────────────────────────────────────────────────────────

// Payloads are deliberately minimal — only the IDs needed to look up the full
// record from the database. Actual data lives in the DB rows.

export interface QueuePayload {
  jobId: string
  tenantId: string
}

export interface DistributePayload {
  distributionId: string
  tenantId: string
}

// ── Redis connection ──────────────────────────────────────────────────────────

function makeRedisConnection(): Redis {
  const url = process.env['REDIS_URL']
  if (!url) throw new Error('REDIS_URL is not set')
  // maxRetriesPerRequest: null is required by BullMQ for blocking commands
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false })
}

// ── Queue singleton ───────────────────────────────────────────────────────────

let _queue: Queue<QueuePayload> | null = null

export function getQueue(): Queue<QueuePayload> {
  if (!_queue) {
    _queue = new Queue<QueuePayload>(QUEUE_NAME, {
      connection: makeRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'fixed', delay: 15_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    })
  }
  return _queue
}

// ── Worker factory ────────────────────────────────────────────────────────────

export function getWorker(handler: Processor<QueuePayload>): Worker<QueuePayload> {
  return new Worker<QueuePayload>(QUEUE_NAME, handler, {
    connection: makeRedisConnection(),
    concurrency: 1,
  })
}

// ── Job kind constants ────────────────────────────────────────────────────────

export const VOICE_CLONE_TRAIN = 'voice_clone_train' as const
export const SHORT_POST_SCHEDULED = 'short_post_scheduled' as const

// ── Enqueue render job ────────────────────────────────────────────────────────

export async function enqueueJob(opts: {
  jobId: string
  tenantId: string
  kind: string
}): Promise<void> {
  const queue = getQueue()

  // Remove any existing BullMQ job with the same ID (e.g., after a manual retry)
  // so we can safely re-enqueue with the same jobId.
  const existing = await queue.getJob(opts.jobId)
  if (existing) await existing.remove()

  await queue.add(
    opts.kind, // BullMQ job name — used for dispatch in the worker
    { jobId: opts.jobId, tenantId: opts.tenantId },
    { jobId: opts.jobId }, // use DB job ID as the BullMQ job ID for easy lookup
  )
}

// ── Enqueue voice clone training ──────────────────────────────────────────────
// Uses the same fantom-render queue; the worker dispatches by bullJob.name.
// QueuePayload.jobId = cloneId so the worker can look up the voice_clone row.

export async function enqueueVoiceClone(opts: {
  cloneId: string
  tenantId: string
}): Promise<void> {
  await enqueueJob({ jobId: opts.cloneId, tenantId: opts.tenantId, kind: VOICE_CLONE_TRAIN })
}

// ── Enqueue short video render ────────────────────────────────────────────────

export async function enqueueShortRender(opts: {
  jobId: string
  tenantId: string
}): Promise<void> {
  await enqueueJob({ jobId: opts.jobId, tenantId: opts.tenantId, kind: JobKind.RENDER_SHORT_VIDEO })
}

// ── Enqueue scheduled short post ──────────────────────────────────────────────
// Fired with a delay so it executes at the target posting time.

export async function enqueueScheduledShortPost(opts: {
  shortsJobId: string
  tenantId: string
  delayMs: number
}): Promise<void> {
  const queue = getQueue()
  // Use shortsJobId as BullMQ job ID so we can deduplicate / cancel later.
  const existing = await queue.getJob(`scheduled:${opts.shortsJobId}`)
  if (existing) await existing.remove()

  await queue.add(
    SHORT_POST_SCHEDULED,
    { jobId: opts.shortsJobId, tenantId: opts.tenantId },
    { jobId: `scheduled:${opts.shortsJobId}`, delay: opts.delayMs },
  )
}

// ── Distribute queue singleton ────────────────────────────────────────────────

let _distributeQueue: Queue<DistributePayload> | null = null

export function getDistributeQueue(): Queue<DistributePayload> {
  if (!_distributeQueue) {
    _distributeQueue = new Queue<DistributePayload>(DISTRIBUTE_QUEUE_NAME, {
      connection: makeRedisConnection(),
      defaultJobOptions: {
        attempts: 4,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    })
  }
  return _distributeQueue
}

export function getDistributeWorker(
  handler: Processor<DistributePayload>,
): Worker<DistributePayload> {
  return new Worker<DistributePayload>(DISTRIBUTE_QUEUE_NAME, handler, {
    connection: makeRedisConnection(),
    concurrency: 3, // distributions can run in parallel; they're I/O-bound
  })
}

// ── Enqueue distribution ──────────────────────────────────────────────────────

export async function enqueueDistribution(opts: {
  distributionId: string
  tenantId: string
  kind: string
}): Promise<void> {
  const queue = getDistributeQueue()

  // Remove any existing BullMQ job with the same ID (e.g., after a retry reset)
  const existing = await queue.getJob(opts.distributionId)
  if (existing) await existing.remove()

  await queue.add(
    opts.kind, // destination kind — used for dispatch in the worker
    { distributionId: opts.distributionId, tenantId: opts.tenantId },
    { jobId: opts.distributionId },
  )
}
