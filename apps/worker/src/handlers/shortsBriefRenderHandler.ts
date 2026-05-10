import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Job as BullJob } from 'bullmq'
import type { ShortsRenderPayload } from '@fantom/jobs'
import { putObjectFromFile } from '@fantom/storage'
import { logEvent } from '@fantom/observability'
import { assembleShortFromBrief } from '../lib/assembleShort.js'
import { generateVO } from '../lib/generateVO.js'
import { mixVoiceover } from '../lib/voMix.js'
import {
  getShortsRenderRow,
  patchShortsRender,
  patchShortsBrief,
  getShortsBriefRow,
  getAssetsInOrder,
  createShortsRenderedAsset,
  getTenantSlug,
} from '../lib/db.js'

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

// ── R2 upload with one retry ──────────────────────────────────────────────────

async function uploadWithRetry(
  r2Key: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  try {
    await putObjectFromFile(r2Key, filePath, contentType)
  } catch (firstErr) {
    console.warn(`[r2] upload failed on first attempt, retrying once...`, firstErr)
    await new Promise((r) => setTimeout(r, 2_000))
    await putObjectFromFile(r2Key, filePath, contentType)
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleShortsBriefRender(
  bullJob: BullJob<ShortsRenderPayload>,
): Promise<void> {
  const { renderId, briefId, tenantId } = bullJob.data
  const startedAt = new Date()
  const workDir = join(tmpdir(), `fantom-render-${renderId}`)

  const log = (msg: string) => console.log(`[shorts-render:${renderId}] ${msg}`)
  log(`starting — brief: ${briefId}`)

  await mkdir(workDir, { recursive: true })

  // Mark render running + brief rendering
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
    // ── Fetch brief ───────────────────────────────────────────────────────────

    const brief = await getShortsBriefRow(briefId, tenantId)
    if (!brief) throw new Error(`Brief ${briefId} not found`)

    // ── Hydrate source assets in order ────────────────────────────────────────

    const allAssets = await getAssetsInOrder(brief.sourceAssetIds, tenantId)

    const clips = allAssets
      .filter((a) => a.normalizedR2Key != null)
      .map((a) => ({
        assetId: a.id,
        normalizedR2Key: a.normalizedR2Key!,
        durationSeconds: a.durationSeconds,
        audioChannels: a.audioChannels,
        transcriptWordTimestamps: a.transcriptWordTimestamps as import('../lib/snapCuts.js').TranscriptWord[] | null,
      }))

    if (clips.length === 0) {
      throw new Error(
        allAssets.length === 0
          ? 'No source assets found for this brief'
          : 'No preprocessed source clips available — re-upload or wait for preprocessing to complete',
      )
    }

    const skippedCount = allAssets.length - clips.length
    if (skippedCount > 0) {
      log(`WARNING: ${skippedCount} asset(s) missing normalizedR2Key — skipped`)
    }

    // ── Assemble ──────────────────────────────────────────────────────────────
    // checkCancelled is wired in before each long step inside assembleShortFromBrief:
    // once before downloads, once before ffmpeg. We also check here before upload.

    const assembly = await assembleShortFromBrief(
      {
        brief: { durationSeconds: brief.durationSeconds, pacing: brief.pacing },
        clips,
        workDir,
        renderId,
        log,
      },
      () => checkCancelled(renderId, tenantId),
    )

    // ── VO generation + audio mix ─────────────────────────────────────────────
    // Only runs when a voice is selected AND at least one scene has a VO script.

    const tenantSlug = await getTenantSlug(tenantId)

    let finalOutputPath = assembly.outputPath

    const scenes = Array.isArray(brief.mainScenes) ? (brief.mainScenes as Array<{ id: string; description: string; voiceover_script?: string }>) : []
    const voScenes = scenes
      .filter((s) => typeof s.voiceover_script === 'string' && s.voiceover_script.trim())
      .map((s) => ({ id: s.id, voiceover_script: s.voiceover_script! }))

    if (brief.voiceCloneId && voScenes.length > 0) {
      await checkCancelled(renderId, tenantId)

      log(`generating VO for ${voScenes.length} scene(s) with voice ${brief.voiceCloneId}`)
      const voFiles = await generateVO({
        scenes: voScenes,
        voiceId: brief.voiceCloneId,
        tenantSlug,
        workDir,
        log,
      })

      if (voFiles.length > 0) {
        await checkCancelled(renderId, tenantId)

        log(`mixing ${voFiles.length} VO segment(s) into video`)
        finalOutputPath = await mixVoiceover({
          videoPath: assembly.outputPath,
          voFiles,
          workDir,
          log,
        })
      }
    }

    // ── Upload to R2 ──────────────────────────────────────────────────────────

    await checkCancelled(renderId, tenantId)

    // Deterministic path: makes it easy to find the render output in R2 by renderId
    const r2Key = `${tenantSlug}/shorts-renders/${renderId}/output.mp4`

    log(`uploading → ${r2Key}`)
    await uploadWithRetry(r2Key, finalOutputPath, 'video/mp4')

    const { size: sizeBytes } = await stat(finalOutputPath)

    // ── Create asset record ───────────────────────────────────────────────────
    // metadata.source=false is a hard guardrail — never changes for render outputs.
    // See createShortsRenderedAsset in lib/db.ts for full rationale.

    const asset = await createShortsRenderedAsset({
      tenantId,
      r2Key,
      sizeBytes,
      durationSeconds: assembly.actualDurationSeconds,
      metadata: {
        renderId,
        briefId,
        assemblyVersion: '1B.6',
        sourceClipCount: assembly.sourceClipCount,
        targetDurationS: brief.durationSeconds,
        actualDurationS: assembly.actualDurationSeconds,
        hasVO: voScenes.length > 0 && Boolean(brief.voiceCloneId),
      },
    })

    log(`asset created: ${asset.id}`)

    // ── Mark completed ────────────────────────────────────────────────────────

    const finishedAt = new Date()
    const durationMs = finishedAt.getTime() - startedAt.getTime()

    await patchShortsRender(renderId, tenantId, {
      status: 'completed',
      outputAssetId: asset.id,
      finishedAt,
      durationMs,
    })
    await patchShortsBrief(briefId, tenantId, { status: 'rendered', errorMessage: null })

    logEvent({
      tenantId,
      kind: 'shorts.render.completed',
      severity: 'info',
      subjectType: 'shorts_render',
      subjectId: renderId,
      metadata: {
        briefId,
        assetId: asset.id,
        durationMs,
        r2Key,
        assemblyVersion: '1B.6',
        sourceClipCount: assembly.sourceClipCount,
        actualDurationS: assembly.actualDurationSeconds,
        targetDurationS: brief.durationSeconds,
        hasVO: voScenes.length > 0 && Boolean(brief.voiceCloneId),
      },
    })

    log(`completed in ${durationMs}ms — ${assembly.actualDurationSeconds.toFixed(2)}s video`)
  } catch (err) {
    // ── Cancellation — not an error; do not rethrow ───────────────────────────
    if (err instanceof ShortsBriefRenderCancelledError) {
      log('cancelled')

      await patchShortsRender(renderId, tenantId, {
        status: 'cancelled',
        finishedAt: new Date(),
      }).catch(console.error)

      // Revert brief to 'ready' so it can be re-submitted immediately
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
    // Truncate ffmpeg stderr blobs to keep error_message column reasonable
    const truncated = errMessage.slice(0, 2048)

    await patchShortsRender(renderId, tenantId, {
      status: 'failed',
      errorMessage: truncated,
      finishedAt: new Date(),
    }).catch(console.error)

    await patchShortsBrief(briefId, tenantId, {
      status: 'failed',
      errorMessage: truncated,
    }).catch(console.error)

    logEvent({
      tenantId,
      kind: 'shorts.render.failed',
      severity: 'error',
      subjectType: 'shorts_render',
      subjectId: renderId,
      metadata: { briefId },
      errorMessage: truncated,
    })

    console.error(`[shorts-render:${renderId}] failed:`, err)
    throw err
  } finally {
    // Always clean up the work directory — success, failure, or cancellation
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
