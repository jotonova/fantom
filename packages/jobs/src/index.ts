import { Queue, Worker } from 'bullmq'
import type { Processor } from 'bullmq'
import { Redis } from 'ioredis'

// ── Constants ─────────────────────────────────────────────────────────────────

export const QUEUE_NAME = 'fantom-render'

// ── Job kinds ─────────────────────────────────────────────────────────────────

export const JobKind = {
  RENDER_TEST_VIDEO: 'render_test_video',
  RENDER_LISTING_VIDEO: 'render_listing_video',
  RENDER_MARKET_UPDATE: 'render_market_update',
  RENDER_VIRTUAL_TOUR: 'render_virtual_tour',
  RENDER_FLIP_VIDEO: 'render_flip_video',
  RENDER_YOUTUBE_EDIT: 'render_youtube_edit',
} as const

export type JobKindValue = (typeof JobKind)[keyof typeof JobKind]

// ── BullMQ payload ────────────────────────────────────────────────────────────

// The BullMQ payload is deliberately minimal — only the IDs needed to look up
// the full job from the database. The actual job input lives in jobs.input (DB).
export interface QueuePayload {
  jobId: string
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

// ── Enqueue ───────────────────────────────────────────────────────────────────

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
