import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getObjectToFile, putObjectFromFile } from '@fantom/storage'
import { logEvent } from '@fantom/observability'
import { probeVideo } from '../lib/videoProbe.js'
import { generateThumbnail } from '../lib/videoThumbnail.js'
import { detectScenes } from '../lib/sceneDetect.js'
import { getAssetRow, patchAsset, getTenantSlug } from '../lib/db.js'

// ── runVideoPreprocess ────────────────────────────────────────────────────────

/**
 * Phase 1 of video preprocessing: ffprobe metadata extraction + thumbnail.
 *
 * Flow:
 *   1. Load asset row — validate it's a video in pending/failed state
 *   2. Set transcriptionStatus = 'processing'
 *   3. Download from R2 to temp dir
 *   4. ffprobe: extract codec, fps, bitrate, dimensions, audio channels
 *   5. ffmpeg: extract 1-frame JPEG thumbnail at 10% mark, 1280px wide
 *   6. Upload thumbnail to R2: ${tenantSlug}/thumbnails/${assetId}.jpg
 *   7. Scene detection: detect scene boundaries via ffmpeg select+showinfo
 *   8. Patch asset: codec, fps, bitrateKbps, audioChannels, thumbnailR2Key,
 *                   sceneCount, sceneBoundaries, preprocessedAt,
 *                   transcriptionStatus → 'pending' (ready for 1A.7)
 *   9. Log event
 *  10. Cleanup temp files (always)
 *
 * Additional preprocessing phases (transcription 1A.7, normalization 1A.8)
 * plug in after step 6 without touching the surrounding scaffold.
 */
export async function runVideoPreprocess(
  assetId: string,
  tenantId: string,
  log: (msg: string) => void = console.log,
): Promise<void> {
  log(`starting video preprocess`)

  // ── 1. Load asset ───────────────────────────────────────────────────────────

  const asset = await getAssetRow(assetId, tenantId)
  if (!asset) throw new Error(`Asset ${assetId} not found`)
  if (asset.kind !== 'video') throw new Error(`Asset ${assetId} is not a video (kind=${asset.kind})`)

  const tenantSlug = await getTenantSlug(tenantId)

  // ── 2. Mark as processing ───────────────────────────────────────────────────

  await patchAsset(assetId, tenantId, { transcriptionStatus: 'processing' })
  log(`status → processing`)

  // ── Temp dir ────────────────────────────────────────────────────────────────

  const workDir = join(tmpdir(), `fantom-preprocess-${randomUUID()}`)
  await fs.mkdir(workDir, { recursive: true })

  const videoPath = join(workDir, 'video.bin')
  const thumbPath = join(workDir, 'thumb.jpg')

  try {
    // ── 3. Download from R2 ───────────────────────────────────────────────────

    log(`downloading ${asset.r2Key} (${(Number(asset.sizeBytes) / 1_048_576).toFixed(1)} MB)`)
    await getObjectToFile(asset.r2Key, videoPath)
    log(`download complete`)

    // ── 4. ffprobe ────────────────────────────────────────────────────────────

    log(`running ffprobe`)
    const probe = await probeVideo(videoPath)
    log(`probe: ${probe.codec} ${probe.width}×${probe.height} ${probe.fps.toFixed(2)}fps ${probe.bitrateKbps}kbps`)

    // ── 5. Thumbnail ──────────────────────────────────────────────────────────

    const duration = asset.durationSeconds != null ? Number(asset.durationSeconds) : probe.durationSeconds
    log(`generating thumbnail (seek to ${(duration * 0.1).toFixed(1)}s)`)
    await generateThumbnail(videoPath, thumbPath, duration)
    log(`thumbnail generated`)

    // ── 6. Upload thumbnail ───────────────────────────────────────────────────

    const thumbnailR2Key = `${tenantSlug}/thumbnails/${assetId}.jpg`
    await putObjectFromFile(thumbnailR2Key, thumbPath, 'image/jpeg')
    log(`thumbnail uploaded → ${thumbnailR2Key}`)

    // ── 7. Scene detection ────────────────────────────────────────────────────

    let sceneCount = 1
    let sceneBoundaries: number[] = [0.0]

    try {
      log(`detecting scenes`)
      const scenes = await detectScenes(videoPath, duration)
      sceneCount = scenes.sceneCount
      sceneBoundaries = scenes.sceneBoundaries
      log(`scenes: ${sceneCount} detected`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log(`scene detection failed (non-fatal): ${errMsg}`)
      logEvent({
        tenantId,
        kind: 'video.preprocess.scenes_failed',
        severity: 'warn',
        subjectType: 'asset',
        subjectId: assetId,
        metadata: { errorMessage: errMsg },
      })
      // Fallback already set above — continue
    }

    // ── 8. Patch asset ────────────────────────────────────────────────────────

    await patchAsset(assetId, tenantId, {
      codec: probe.codec,
      fps: String(Math.round(probe.fps * 100) / 100), // round to 2 decimal places
      bitrateKbps: probe.bitrateKbps,
      audioChannels: probe.audioChannels,
      thumbnailR2Key,
      sceneCount,
      sceneBoundaries,
      preprocessedAt: new Date(),
      transcriptionStatus: 'pending', // ready for transcription in 1A.7
    })
    log(`asset patched with probe + scene results`)

    // ── 9. Log event ──────────────────────────────────────────────────────────

    logEvent({
      tenantId,
      kind: 'asset.preprocessed',
      severity: 'info',
      subjectType: 'asset',
      subjectId: assetId,
      metadata: {
        codec: probe.codec,
        fps: probe.fps,
        bitrateKbps: probe.bitrateKbps,
        thumbnailR2Key,
        sceneCount,
      },
    })

    log(`preprocess complete`)
  } catch (err) {
    // Mark as failed so the UI can surface the error and offer a reprocess button
    await patchAsset(assetId, tenantId, {
      transcriptionStatus: 'failed',
    }).catch((patchErr) => {
      console.error(`[preprocess:${assetId}] failed to mark asset as failed:`, patchErr)
    })

    logEvent({
      tenantId,
      kind: 'asset.preprocess_failed',
      severity: 'error',
      subjectType: 'asset',
      subjectId: assetId,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorStack: err instanceof Error ? (err.stack ?? null) : null,
    })

    throw err
  } finally {
    // ── 9. Cleanup ────────────────────────────────────────────────────────────
    await fs.rm(workDir, { recursive: true, force: true }).catch((e) => {
      console.error(`[preprocess:${assetId}] cleanup failed:`, e)
    })
    log(`temp files cleaned up`)
  }
}
