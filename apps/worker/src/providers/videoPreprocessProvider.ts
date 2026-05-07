import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getObjectToFile, putObjectFromFile, generateDownloadUrl } from '@fantom/storage'
import { logEvent } from '@fantom/observability'
import { probeVideo } from '../lib/videoProbe.js'
import { generateThumbnail } from '../lib/videoThumbnail.js'
import { detectScenes } from '../lib/sceneDetect.js'
import { transcribeFile } from '../lib/assemblyai.js'
import {
  estimateTranscriptionCost,
  checkCanTranscribe,
  recordUsage,
  checkSoftCapAlert,
  getDailySpendUsd,
  getMonthlySpendUsd,
} from '../lib/assemblyaiCostCap.js'
import { normalizeVideo } from '../lib/normalizeVideo.js'
import { measureLoudness } from '../lib/audioNormalize.js'
import { getAssetRow, patchAsset, getTenantSlug } from '../lib/db.js'

// ── runVideoPreprocess ────────────────────────────────────────────────────────

/**
 * Full video preprocessing pipeline:
 *   1.  Load asset row
 *   2.  Set transcriptionStatus = 'processing'
 *   3.  Download from R2 to temp dir
 *   4.  ffprobe: codec, fps, bitrate, dimensions, audio channels
 *   5.  ffmpeg: thumbnail at 10% mark → upload to R2
 *   6.  Scene detection (non-fatal)
 *   7.  Patch asset with probe + scene results, set preprocessedAt
 *   8.  Cost cap check → transcribe via AssemblyAI (non-fatal)
 *   9.  Patch asset with transcription result
 *   10. Normalize video: color correct + audio loudnorm in single pass (non-fatal)
 *   11. Measure loudness on normalized output
 *   12. Upload normalized file to R2
 *   13. Patch asset with normalized fields
 *   14. Log event + cleanup
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
  const normalizedPath = join(workDir, 'normalized.mp4')

  try {
    // ── 3. Download from R2 ───────────────────────────────────────────────────

    log(`downloading ${asset.r2Key} (${(Number(asset.sizeBytes) / 1_048_576).toFixed(1)} MB)`)
    await getObjectToFile(asset.r2Key, videoPath)
    log(`download complete`)

    // ── 4. ffprobe ────────────────────────────────────────────────────────────

    log(`running ffprobe`)
    const probe = await probeVideo(videoPath)
    log(`probe: ${probe.codec} ${probe.width}×${probe.height} ${probe.fps.toFixed(2)}fps ${probe.bitrateKbps}kbps`)

    const hasAudio = probe.audioChannels != null && probe.audioChannels > 0

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
    }

    // ── 8. Patch asset with probe + scene results ─────────────────────────────

    await patchAsset(assetId, tenantId, {
      codec: probe.codec,
      fps: String(Math.round(probe.fps * 100) / 100),
      bitrateKbps: probe.bitrateKbps,
      audioChannels: probe.audioChannels,
      thumbnailR2Key,
      sceneCount,
      sceneBoundaries,
      preprocessedAt: new Date(),
    })
    log(`asset patched with probe + scene results`)

    // ── 9. Estimate transcription cost ────────────────────────────────────────

    const estimatedCost = estimateTranscriptionCost(duration)
    log(`transcription estimate: $${estimatedCost.toFixed(5)} for ${duration.toFixed(1)}s`)

    // ── 10. Cost cap check ────────────────────────────────────────────────────

    const capCheck = await checkCanTranscribe(tenantId, estimatedCost)

    if (!capCheck.allowed) {
      log(`transcription skipped (cap): ${capCheck.reason}`)
      logEvent({
        tenantId,
        kind: 'video.preprocess.transcription_skipped',
        severity: 'warn',
        subjectType: 'asset',
        subjectId: assetId,
        metadata: {
          reason: capCheck.reason,
          capHit: capCheck.capHit,
          dailySpend: capCheck.dailySpend,
          monthlySpend: capCheck.monthlySpend,
          estimatedCost,
        },
      })
      await patchAsset(assetId, tenantId, { transcriptionStatus: 'failed' })
      log(`transcription skipped — continuing to normalization`)
    } else {
      // ── 11. Presigned URL for AssemblyAI ─────────────────────────────────────

      const presignedUrl = await generateDownloadUrl(asset.r2Key, 3600)
      log(`presigned download URL generated (1hr expiry)`)

      // ── 12. Transcribe ────────────────────────────────────────────────────────

      let transcriptText: string | null = null
      let transcriptWords: TranscriptionWord[] | null = null
      let transcriptionFailed = false

      try {
        const result = await transcribeFile(presignedUrl, log)
        transcriptText = result.text
        transcriptWords = result.words

        await recordUsage(tenantId, assetId, result.audioDurationSeconds, result.transcriptId)
        log(`usage recorded: ${result.audioDurationSeconds.toFixed(1)}s audio`)

        const justCrossedSoftCap = await checkSoftCapAlert(tenantId)
        if (justCrossedSoftCap) {
          const [dailySpend, monthlySpend] = await Promise.all([
            getDailySpendUsd(tenantId),
            getMonthlySpendUsd(tenantId),
          ])
          logEvent({
            tenantId,
            kind: 'cost_cap.assemblyai_soft_cap_crossed',
            severity: 'warn',
            subjectType: 'asset',
            subjectId: assetId,
            metadata: { dailySpend, monthlySpend },
          })
          log(`soft cap crossed — in-app alert logged`)
        }
      } catch (err) {
        transcriptionFailed = true
        const errMsg = err instanceof Error ? err.message : String(err)
        log(`transcription failed (non-fatal): ${errMsg}`)
        logEvent({
          tenantId,
          kind: 'video.preprocess.transcription_failed',
          severity: 'error',
          subjectType: 'asset',
          subjectId: assetId,
          errorMessage: errMsg,
          errorStack: err instanceof Error ? (err.stack ?? null) : null,
        })
      }

      await patchAsset(assetId, tenantId, {
        transcriptText: transcriptText ?? null,
        transcriptWordTimestamps: transcriptWords ?? null,
        transcriptionStatus: transcriptionFailed ? 'failed' : 'complete',
      })
      log(`transcription status → ${transcriptionFailed ? 'failed' : 'complete'}`)
    }

    // ── 13. Normalize video (color correct + audio loudnorm) ──────────────────

    let normalizedR2Key: string | null = null
    let normalizedSizeBytes: number | null = null
    let loudnessLufs: number | null = null
    let loudnessTruePeakDb: number | null = null
    let normalizedCodec: string | null = null
    let normalizedAudioCodec: string | null = null

    try {
      const normResult = await normalizeVideo(videoPath, normalizedPath, hasAudio, log)
      normalizedSizeBytes = normResult.sizeBytes
      normalizedCodec = normResult.videoCodec
      normalizedAudioCodec = normResult.audioCodec

      // ── 14. Measure loudness on normalized output ─────────────────────────

      if (hasAudio) {
        log(`measuring loudness`)
        const loudness = await measureLoudness(normalizedPath)
        if (isFinite(loudness.integratedLufs)) {
          loudnessLufs = loudness.integratedLufs
          loudnessTruePeakDb = loudness.truePeakDb
          log(`loudness: ${loudnessLufs.toFixed(1)} LUFS / ${loudnessTruePeakDb?.toFixed(1)} dBTP`)
        } else {
          log(`loudness: silent/no-audio`)
        }
      }

      // ── 15. Upload normalized file to R2 ─────────────────────────────────

      normalizedR2Key = `${tenantSlug}/normalized/${assetId}.mp4`
      await putObjectFromFile(normalizedR2Key, normalizedPath, 'video/mp4')
      log(`normalized uploaded → ${normalizedR2Key} (${(normalizedSizeBytes / 1_048_576).toFixed(1)} MB)`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log(`normalization failed (non-fatal): ${errMsg}`)
      logEvent({
        tenantId,
        kind: 'video.preprocess.normalize_failed',
        severity: 'warn',
        subjectType: 'asset',
        subjectId: assetId,
        metadata: { errorMessage: errMsg },
      })
      // normalized_* fields stay null — rendering falls back to original file
    }

    // ── 16. Patch asset with normalized results ───────────────────────────────

    await patchAsset(assetId, tenantId, {
      normalizedR2Key: normalizedR2Key ?? undefined,
      normalizedSizeBytes: normalizedSizeBytes ?? undefined,
      normalizedCodec: normalizedCodec ?? undefined,
      normalizedAudioCodec: normalizedAudioCodec ?? undefined,
      loudnessLufs: loudnessLufs != null ? String(loudnessLufs) : undefined,
      loudnessTruePeakDb: loudnessTruePeakDb != null ? String(loudnessTruePeakDb) : undefined,
    })
    log(`asset patched with normalized results`)

    // ── 17. Log event ─────────────────────────────────────────────────────────

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
        normalizedR2Key,
        loudnessLufs,
      },
    })

    log(`preprocess complete`)
  } catch (err) {
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
    await fs.rm(workDir, { recursive: true, force: true }).catch((e) => {
      console.error(`[preprocess:${assetId}] cleanup failed:`, e)
    })
    log(`temp files cleaned up`)
  }
}

// ── Internal types ────────────────────────────────────────────────────────────

interface TranscriptionWord {
  text: string
  start: number
  end: number
  confidence: number
}
