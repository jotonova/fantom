import { execFile } from 'node:child_process'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import type { Job as BullJob } from 'bullmq'
import type { ShortsRenderPayload } from '@fantom/jobs'
import { putObjectFromFile, getObjectToFile } from '@fantom/storage'
import { logEvent } from '@fantom/observability'
import { assembleShortFromBrief } from '../lib/assembleShort.js'
import { generateVO } from '../lib/generateVO.js'
import { mixVoiceover } from '../lib/voMix.js'
import type { VOFileWithOffset } from '../lib/voMix.js'
import {
  buildAssContent,
  generateCaptionsForRender,
} from '../lib/generateCaptions.js'
import type { CaptionVOSegment } from '../lib/generateCaptions.js'
import { applyBrandOverlays } from '../lib/brandOverlays.js'

// Bundled font — committed at apps/worker/assets/NotoSans-Regular.ttf.
// Resolved relative to this compiled file so it works in both dev (src/) and
// production (dist/). Path from dist/handlers/ → ../../assets/.
const CAPTION_FONT_DIR = fileURLToPath(new URL('../../assets', import.meta.url))

// Use the ffmpeg-static binary so caption burns get the libass-enabled build,
// not whatever system ffmpeg happens to be in PATH on the Render host.
const _require = createRequire(import.meta.url)
const ffmpegBin: string = (_require('ffmpeg-static') as string | null) ?? 'ffmpeg'
import {
  getShortsRenderRow,
  patchShortsRender,
  patchShortsBrief,
  getShortsBriefRow,
  getAssetsInOrder,
  createShortsRenderedAsset,
  getTenantSlug,
  getBrandKitRow,
  getAssetRow,
} from '../lib/db.js'
import { db, getMusicTrackById } from '@fantom/db'

const execFileAsync = promisify(execFile)

// ── Audio duration probe ───────────────────────────────────────────────────────
// Used to compute clip-position offsets for VO segments (opening → scene 1
// sequencing, and closing placement at video_end - closing_duration).

async function probeAudioMs(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
      { timeout: 10_000, killSignal: 'SIGKILL' },
    )
    return Math.round(parseFloat(stdout.trim()) * 1000) || 0
  } catch {
    return 0
  }
}

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

// Master render timeout — final safety net if any individual ffmpeg or network
// step hangs beyond its own timeout. Pipeline worst-case on Render Standard:
//   assembly(5min) + brand(10min) + vo(2min) + mix(5min) + captions(10min) = 32min.
// 20 minutes is generous but still finite; raises a clean error that the catch
// block can surface to the DB so Justin can see what happened.
const MASTER_TIMEOUT_MS = 20 * 60_000

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

  // Race the entire pipeline against a master timeout. This catches any step
  // that hangs beyond its own timeout (e.g. ffmpeg in uninterruptible D-state
  // after SIGTERM was sent but before SIGKILL took effect, or a future code path
  // added without an explicit timeout).
  let _masterTimeoutId: ReturnType<typeof setTimeout> | undefined
  const _masterTimeoutPromise = new Promise<never>((_, reject) => {
    _masterTimeoutId = setTimeout(
      () => reject(new Error(`Render master timeout: pipeline exceeded ${MASTER_TIMEOUT_MS / 60_000} minutes — check worker logs for the hung step`)),
      MASTER_TIMEOUT_MS,
    )
  })

  try {
    await Promise.race([
      (async () => {

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
        sceneBoundaries: a.sceneBoundaries as number[] | null,
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
        brief: {
          durationSeconds: brief.durationSeconds,
          pacing: brief.pacing,
          density: (brief.density as 'low' | 'medium' | 'high' | null) ?? 'medium',
        },
        clips,
        workDir,
        renderId,
        log,
      },
      () => checkCancelled(renderId, tenantId),
    )

    // ── Brand watermark (1B.8) ───────────────────────────────────────────────────
    // If brief.brandKitId is set and the kit has a logo, overlays a persistent
    // watermark (top-right, 90 px tall) on the assembled video.
    // No intro/outro splashes, no lower-third. Watermark only.
    // introDurationMs is always 0 — no timing shifts for VO, captions, or music.

    const tenantSlug = await getTenantSlug(tenantId)

    let finalOutputPath = assembly.outputPath
    const introDurationMs = 0  // watermark-only: no intro added, no timing shift needed

    if (brief.brandKitId) {
      await checkCancelled(renderId, tenantId)
      log(`brand kit ${brief.brandKitId} — fetching…`)

      let brandKit: Awaited<ReturnType<typeof getBrandKitRow>> | undefined
      try {
        brandKit = await getBrandKitRow(brief.brandKitId, tenantId)
      } catch (bkErr) {
        log(`WARNING: brand kit fetch failed — rendering without watermark: ${bkErr instanceof Error ? bkErr.message : String(bkErr)}`)
      }

      if (brandKit) {
        // Fetch logo asset r2Key (if kit has a logo)
        let logoR2Key: string | null = null
        if (brandKit.logoAssetId) {
          try {
            const logoAsset = await getAssetRow(brandKit.logoAssetId, tenantId)
            logoR2Key = logoAsset?.r2Key ?? null
          } catch {
            log(`WARNING: logo asset fetch failed — skipping watermark`)
          }
        }

        try {
          const overlayResult = await applyBrandOverlays({
            scenesPath: assembly.outputPath,
            brandKit,
            logoR2Key,
            ctaText: null,
            workDir,
            fontDir: CAPTION_FONT_DIR,
            ffmpegBin,
            log,
          })
          finalOutputPath = overlayResult.outputPath

          logEvent({
            tenantId,
            kind: 'shorts.render.brand_applied',
            severity: 'info',
            subjectType: 'shorts_render',
            subjectId: renderId,
            metadata: {
              briefId,
              brandKitId: brandKit.id,
              brandKitName: brandKit.name,
              hasWatermark: overlayResult.hadLogo,
            },
          })
          log(`brand watermark applied — hadLogo=${overlayResult.hadLogo}`)
        } catch (overlayErr) {
          // Fail soft — render continues without watermark.
          const stderr = (overlayErr as { stderr?: string }).stderr?.slice(-2000) ?? ''
          const msg = overlayErr instanceof Error ? overlayErr.message.slice(-400) : String(overlayErr)
          const detail = stderr || msg
          log(`WARNING: brand watermark pass failed — rendering without watermark:\n${detail}`)
          logEvent({
            tenantId,
            kind: 'shorts.render.brand_failed',
            severity: 'error',
            subjectType: 'shorts_render',
            subjectId: renderId,
            metadata: {
              briefId,
              brandKitId: brandKit.id,
              error: detail.slice(0, 1000),
            },
          })
          finalOutputPath = assembly.outputPath
        }
      } else {
        log(`WARNING: brand kit ${brief.brandKitId} not found — rendering without watermark`)
      }
    }

    // ── VO generation + audio mix ─────────────────────────────────────────────
    // Only runs when a voice is selected AND at least one scene has a VO script.
    //
    // Offset model (1B.6.1 scope — 1 brief scene = 1 source clip, sequential):
    //   Opening VO  → offset 0 (start of video)
    //   Scene[i] VO → offset = clipStartTimes[i] (seconds into assembled video)
    //                 If opening VO exists, scene[0] is further offset by opening_duration.
    //   Closing VO  → offset = actualDurationSeconds - closing_duration
    //                 Floored at last clip's start.

    const scenes = Array.isArray(brief.mainScenes)
      ? (brief.mainScenes as Array<{ id: string; description: string; voiceover_script?: string }>)
      : []

    // Collect VO specs: opening → scene VOs (filtered to those with scripts) → closing
    const hasOpeningVO = Boolean(brief.openingVoiceoverScript?.trim())
    const hasClosingVO = Boolean(brief.closingVoiceoverScript?.trim())

    const voScenes = [
      ...(hasOpeningVO
        ? [{ id: 'opening', voiceover_script: brief.openingVoiceoverScript! }]
        : []),
      ...scenes
        .filter((s) => typeof s.voiceover_script === 'string' && s.voiceover_script.trim())
        .map((s) => ({ id: s.id, voiceover_script: s.voiceover_script! })),
      ...(hasClosingVO
        ? [{ id: 'closing', voiceover_script: brief.closingVoiceoverScript! }]
        : []),
    ]

    // ── VO generation ────────────────────────────────────────────────────────

    let voFilesWithOffsets: VOFileWithOffset[] = []

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
        // ── Compute clip-position offsets ─────────────────────────────────
        // assembly.clipStartTimes[i] = seconds into the assembled video where
        // clip i begins. Scene[i] maps 1:1 to clip[i].

        const { clipStartTimes, clipDurations, actualDurationSeconds } = assembly
        const clipCount = clipStartTimes.length

        let openingDurationMs = 0
        if (hasOpeningVO) {
          const openingFile = voFiles.find((f) => f.sceneId === 'opening')
          if (openingFile) openingDurationMs = await probeAudioMs(openingFile.audioPath)
        }

        let closingDurationMs = 0
        if (hasClosingVO) {
          const closingFile = voFiles.find((f) => f.sceneId === 'closing')
          if (closingFile) closingDurationMs = await probeAudioMs(closingFile.audioPath)
        }

        let sceneVoIdx = 0

        for (const vf of voFiles) {
          if (vf.sceneId === 'opening') {
            voFilesWithOffsets.push({ ...vf, startOffsetMs: 0 })
            continue
          }

          if (vf.sceneId === 'closing') {
            const lastClipStartMs = (clipStartTimes[clipCount - 1] ?? 0) * 1000
            const closingOffsetMs = Math.max(
              actualDurationSeconds * 1000 - closingDurationMs,
              lastClipStartMs,
            )
            voFilesWithOffsets.push({ ...vf, startOffsetMs: closingOffsetMs })
            log(
              `  closing VO offset: ${(closingOffsetMs / 1000).toFixed(2)}s ` +
                `(video=${actualDurationSeconds.toFixed(2)}s, vo=${(closingDurationMs / 1000).toFixed(2)}s)`,
            )
            continue
          }

          const clipIdx = sceneVoIdx
          if (clipIdx >= clipCount) {
            log(
              `  WARNING: scene VO "${vf.sceneId}" (index ${clipIdx}) has no clip — ` +
                `brief has ${clipCount} clip(s), skipping`,
            )
            sceneVoIdx++
            continue
          }

          let offsetMs: number
          if (clipIdx === 0 && hasOpeningVO) {
            offsetMs = openingDurationMs
            const clip1EndMs = (clipStartTimes[0]! + clipDurations[0]!) * 1000
            if (openingDurationMs > clip1EndMs) {
              log(`  WARNING: opening VO may overflow clip 1 duration`)
            }
          } else {
            offsetMs = clipStartTimes[clipIdx]! * 1000
          }

          voFilesWithOffsets.push({ ...vf, startOffsetMs: offsetMs })
          log(
            `  scene VO "${vf.sceneId}" → clip ${clipIdx + 1} offset ${(offsetMs / 1000).toFixed(2)}s`,
          )
          sceneVoIdx++
        }

      }
    }

    // ── Music track fetch ─────────────────────────────────────────────────────
    // Music is independent of VO — a brief may have music but no voice, or both.

    const brandedTotalSeconds = assembly.actualDurationSeconds

    let musicLayer: { localPath: string; slug: string; videoDurationSeconds: number } | undefined
    if (brief.musicTrackId) {
      const track = await getMusicTrackById(db, brief.musicTrackId)
      if (!track) {
        log(`WARNING: music_track_id ${brief.musicTrackId} not found — rendering without music`)
      } else if (!track.isActive) {
        log(`WARNING: music track "${track.slug}" is inactive — rendering without music`)
      } else {
        const musicLocalPath = join(workDir, `music_${track.slug}.mp3`)
        log(`downloading music track: ${track.r2Key}`)
        await getObjectToFile(track.r2Key, musicLocalPath)
        musicLayer = {
          localPath: musicLocalPath,
          slug: track.slug,
          videoDurationSeconds: brandedTotalSeconds,
        }
      }
    }

    // ── Audio mix ─────────────────────────────────────────────────────────────

    if (voFilesWithOffsets.length > 0 || musicLayer) {
      await checkCancelled(renderId, tenantId)
      log(
        `audio mix: ${voFilesWithOffsets.length} VO segment(s)` +
          (musicLayer ? ` + music (${musicLayer.slug})` : ''),
      )
      // Use finalOutputPath — when brand overlays ran this is branded.mp4
      // (intro + scenes + outro), otherwise it is the plain assembly output.
      const mixInput = finalOutputPath
      finalOutputPath = await mixVoiceover({
        videoPath: mixInput,
        voFiles: voFilesWithOffsets,
        workDir,
        log,
        ...(musicLayer !== undefined && { music: musicLayer }),
      })
    }

    // ── Burned-in captions ────────────────────────────────────────────────────
    // Runs after audio mix so the caption burn gets the fully-mixed audio track.
    // Uses a second ffmpeg pass: -vf "ass=..." -c:a copy (audio untouched).

    if (brief.captionsEnabled) {
      await checkCancelled(renderId, tenantId)
      log('generating captions…')

      // Build per-clip caption inputs.
      // clipTrimStartMs: where in the source asset the clip was trimmed from (converts
      //   source-relative AssemblyAI timestamps to clip-local times).
      // clipStartMsInVideo: where the clip starts in the assembled video.
      const captionClips = clips.map((clip, i) => ({
        transcriptWords: clip.transcriptWordTimestamps,
        clipTrimStartMs: (assembly.clipTrimStartTimes[i] ?? 0) * 1000,
        clipStartMsInVideo: (assembly.clipStartTimes[i] ?? 0) * 1000,
      }))

      // Build VO segments (probe each VO file for its duration)
      const voSceneScriptMap = new Map(voScenes.map((s) => [s.id, s.voiceover_script]))
      const captionVOSegments: CaptionVOSegment[] = []
      for (const vf of voFilesWithOffsets) {
        const script = voSceneScriptMap.get(vf.sceneId)
        if (!script) continue
        const durationMs = await probeAudioMs(vf.audioPath)
        captionVOSegments.push({ script, startOffsetMs: vf.startOffsetMs, durationMs })
      }

      const captionSegments = await generateCaptionsForRender({
        clips: captionClips,
        voSegments: captionVOSegments,
        videoDurationMs: assembly.actualDurationSeconds * 1000,
        log,
      })

      const captionCount = captionSegments.length
      const captionedPath = join(workDir, 'output_captioned.mp4')

      if (captionCount === 0) {
        log('captions: no segments — skipping burn pass')
      } else {
        // Burn captions via libass ass= filter.
        // Uses a bundled NotoSans-Regular.ttf (apps/worker/assets/) via fontsdir=
        // so there is zero dependency on system fonts.
        const assContent = buildAssContent(captionSegments, 'Noto Sans', undefined)
        const assPath = join(workDir, 'captions.ass')
        await writeFile(assPath, assContent, 'utf-8')

        // fontsdir= tells libass to scan our bundled font directory.
        // Escape the paths: colons in paths must be \: in filtergraph option values.
        const escapedAss = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
        const escapedFontDir = CAPTION_FONT_DIR.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
        const vfFilter = `ass=${escapedAss}:fontsdir=${escapedFontDir}`
        log(`burning ${captionCount} caption segment(s) via ass= (fontsdir=${CAPTION_FONT_DIR})…`)
        try {
          await execFileAsync(
            ffmpegBin,
            ['-i', finalOutputPath, '-vf', vfFilter, '-c:a', 'copy', '-y', captionedPath],
            {
              timeout: 600_000, // 10 min — re-encoding a 60s video at ~6fps on Render takes ~3 min
              killSignal: 'SIGKILL', // SIGTERM can be ignored by hung ffmpeg; SIGKILL cannot
            },
          )
          finalOutputPath = captionedPath
          logEvent({
            tenantId,
            kind: 'shorts.render.captions_burned',
            severity: 'info',
            subjectType: 'shorts_render',
            subjectId: renderId,
            metadata: { briefId, captionCount },
          })
          log(`captions burned — ${captionCount} segment(s)`)
        } catch (captionErr) {
          // Degrade gracefully: render still ships without captions if drawtext fails.
          // Use .stderr directly — the full error.message starts with "Command failed: <cmd>"
          // which is thousands of chars long, pushing the actual ffmpeg error off the end.
          const errObj = captionErr as NodeJS.ErrnoException & { stderr?: string; stdout?: string }
          const stderr = errObj.stderr?.trim() ?? ''
          // Capture the TAIL of stderr — ffmpeg's version+config header consumes ~1500 chars
          // at the start; the actual error lines are always at the end.
          const diagMsg = stderr ? stderr.slice(-2000) : (captionErr instanceof Error ? captionErr.message.slice(-500) : String(captionErr))
          log(`WARNING: caption burn failed — continuing without captions:\n${diagMsg.slice(-400)}`)
          logEvent({
            tenantId,
            kind: 'shorts.render.captions_failed',
            severity: 'warn',
            subjectType: 'shorts_render',
            subjectId: renderId,
            errorMessage: diagMsg,
            metadata: { briefId, captionCount },
          })
          // finalOutputPath unchanged — ships the audio-mixed video without caption overlay
        }
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
      durationSeconds: brandedTotalSeconds,
      metadata: {
        renderId,
        briefId,
        assemblyVersion: '1B.9.1',
        density: brief.density ?? 'medium',
        sourceClipCount: assembly.sourceClipCount,
        targetDurationS: brief.durationSeconds,
        actualDurationS: assembly.actualDurationSeconds,
        brandedTotalS: brandedTotalSeconds,
        hasVO: voScenes.length > 0 && Boolean(brief.voiceCloneId),
        musicTrackSlug: musicLayer?.slug ?? null,
        captionsEnabled: brief.captionsEnabled,
        brandKitId: brief.brandKitId ?? null,
        hasBrandOverlays: finalOutputPath !== assembly.outputPath,
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
        assemblyVersion: '1B.9.1',
        sourceClipCount: assembly.sourceClipCount,
        actualDurationS: assembly.actualDurationSeconds,
        targetDurationS: brief.durationSeconds,
        hasVO: voScenes.length > 0 && Boolean(brief.voiceCloneId),
        musicTrackSlug: musicLayer?.slug ?? null,
        captionsEnabled: brief.captionsEnabled,
        brandKitId: brief.brandKitId ?? null,
        hasBrandOverlays: finalOutputPath !== assembly.outputPath,
      },
    })

    log(`completed in ${durationMs}ms — ${brandedTotalSeconds.toFixed(2)}s video (hasWatermark=${finalOutputPath !== assembly.outputPath})`)

      })(), // end of work IIFE
      _masterTimeoutPromise,
    ])
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
    clearTimeout(_masterTimeoutId)
    // Always clean up the work directory — success, failure, or cancellation
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
