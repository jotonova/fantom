import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stat, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Job as BullJob } from 'bullmq'
import type { ShortsRenderPayload } from '@fantom/jobs'
import { buildKey, putObjectFromFile } from '@fantom/storage'
import { logEvent } from '@fantom/observability'
import {
  getShortsRenderRow,
  patchShortsRender,
  patchShortsBrief,
  createShortsPlaceholderAsset,
  getTenantSlug,
} from '../lib/db.js'

const execFileAsync = promisify(execFile)

// ── Cancellation ──────────────────────────────────────────────────────────────

export class ShortsBriefRenderCancelledError extends Error {
  constructor() {
    super('Render cancelled')
    this.name = 'ShortsBriefRenderCancelledError'
  }
}

async function checkCancelled(renderId: string, tenantId: string): Promise<void> {
  const render = await getShortsRenderRow(renderId, tenantId)
  if (render?.status === 'cancelled') throw new ShortsBriefRenderCancelledError()
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleShortsBriefRender(
  bullJob: BullJob<ShortsRenderPayload>,
): Promise<void> {
  const { renderId, briefId, tenantId } = bullJob.data
  const startedAt = new Date()

  console.log(`[shorts-render:${renderId}] starting — brief: ${briefId}`)

  // Mark render as running and brief as rendering
  await patchShortsRender(renderId, tenantId, {
    status: 'running',
    startedAt,
    bullmqJobId: bullJob.id ?? null,
  })
  await patchShortsBrief(briefId, tenantId, { status: 'rendering' })

  logEvent({
    tenantId,
    kind: 'shorts.render.started',
    severity: 'info',
    subjectType: 'shorts_render',
    subjectId: renderId,
    metadata: { briefId, bullmqJobId: bullJob.id },
  })

  try {
    // ── Placeholder sleep (5 × 1s) with cancellation checks ──────────────────
    for (let i = 0; i < 5; i++) {
      await checkCancelled(renderId, tenantId)
      await sleep(1_000)
    }
    await checkCancelled(renderId, tenantId)

    // ── Generate placeholder 1s black 9:16 MP4 via ffmpeg ────────────────────
    const tmpFile = join(tmpdir(), `fantom-shorts-${randomUUID()}.mp4`)
    console.log(`[shorts-render:${renderId}] generating placeholder MP4 → ${tmpFile}`)

    await execFileAsync('ffmpeg', [
      '-f', 'lavfi',
      '-i', 'color=black:s=1080x1920:d=1',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-t', '1',
      '-movflags', '+faststart',
      '-y',
      tmpFile,
    ])

    // ── Upload to R2 ──────────────────────────────────────────────────────────
    const tenantSlug = await getTenantSlug(tenantId)
    const r2Key = buildKey(tenantSlug, 'shorts-renders', 'placeholder.mp4')

    await putObjectFromFile(r2Key, tmpFile, 'video/mp4')

    const { size: sizeBytes } = await stat(tmpFile)
    await rm(tmpFile, { force: true }).catch(() => {})

    // ── Create asset record (metadata.source=false per guardrail) ─────────────
    const asset = await createShortsPlaceholderAsset({
      tenantId,
      r2Key,
      sizeBytes,
      durationSeconds: 1,
      width: 1080,
      height: 1920,
    })

    console.log(`[shorts-render:${renderId}] placeholder asset created: ${asset.id}`)

    // ── Mark completed ────────────────────────────────────────────────────────
    const finishedAt = new Date()
    const durationMs = finishedAt.getTime() - startedAt.getTime()

    await patchShortsRender(renderId, tenantId, {
      status: 'completed',
      outputAssetId: asset.id,
      finishedAt,
      durationMs,
    })
    await patchShortsBrief(briefId, tenantId, {
      status: 'rendered',
      errorMessage: null,
    })

    logEvent({
      tenantId,
      kind: 'shorts.render.completed',
      severity: 'info',
      subjectType: 'shorts_render',
      subjectId: renderId,
      metadata: { briefId, assetId: asset.id, durationMs, r2Key },
    })

    console.log(`[shorts-render:${renderId}] completed in ${durationMs}ms`)
  } catch (err) {
    // ── Cancellation (not an error, do not rethrow) ───────────────────────────
    if (err instanceof ShortsBriefRenderCancelledError) {
      console.log(`[shorts-render:${renderId}] cancelled`)

      await patchShortsRender(renderId, tenantId, {
        status: 'cancelled',
        finishedAt: new Date(),
      }).catch(console.error)

      // Revert brief to 'ready' so it can be re-submitted
      await patchShortsBrief(briefId, tenantId, { status: 'ready' }).catch(console.error)

      logEvent({
        tenantId,
        kind: 'shorts.render.cancelled',
        severity: 'info',
        subjectType: 'shorts_render',
        subjectId: renderId,
        metadata: { briefId },
      })
      return
    }

    // ── Genuine failure ───────────────────────────────────────────────────────
    const errMessage = err instanceof Error ? err.message : String(err)

    await patchShortsRender(renderId, tenantId, {
      status: 'failed',
      errorMessage: errMessage,
      finishedAt: new Date(),
    }).catch(console.error)

    await patchShortsBrief(briefId, tenantId, {
      status: 'failed',
      errorMessage: errMessage,
    }).catch(console.error)

    logEvent({
      tenantId,
      kind: 'shorts.render.failed',
      severity: 'error',
      subjectType: 'shorts_render',
      subjectId: renderId,
      metadata: { briefId },
      errorMessage: errMessage,
    })

    console.error(`[shorts-render:${renderId}] failed:`, err)
    throw err
  }
}
