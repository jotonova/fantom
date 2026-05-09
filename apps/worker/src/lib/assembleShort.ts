/**
 * assembleShortFromBrief — 1B.5 scene assembly engine
 *
 * Concatenates source clips in order, trims to the brief's duration target,
 * and outputs a 1080×1920 9:16 H.264/AAC MP4.
 *
 * 1B.5 scope:
 *   - Hard cuts only (no transitions)
 *   - Center-crop from any source aspect ratio
 *   - Audio: original clip audio (silence if clip has no audio track)
 *   - Pacing drives trim strategy (see buildClipPlan comments)
 *   - Scene boundaries from 1A are NOT used — reserved for 1B.9 regenerate slider
 *   - No VO, captions, music, or overlays (1B.6–1B.8)
 */

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { getObjectToFile } from '@fantom/storage'
import { probeVideo } from './videoProbe.js'
import { snapTrimToSilence, snapToleranceMs } from './snapCuts.js'
import type { TranscriptWord } from './snapCuts.js'

const execFileAsync = promisify(execFile)

const RENDER_TIMEOUT_MS = 5 * 60_000 // 5-minute hard cap

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SourceClipInput {
  assetId: string
  normalizedR2Key: string
  /** Drizzle returns numeric columns as strings — accept either */
  durationSeconds: string | number | null
  audioChannels: number | null
  /** Word timestamps from AssemblyAI preprocessing; null if not yet transcribed */
  transcriptWordTimestamps: TranscriptWord[] | null
}

export interface AssemblyInput {
  brief: {
    durationSeconds: number
    pacing: 'fast' | 'medium' | 'slow' | null
  }
  clips: SourceClipInput[]
  workDir: string
  renderId: string
  log: (msg: string) => void
}

export interface AssemblyResult {
  outputPath: string
  actualDurationSeconds: number
  sourceClipCount: number
  ffmpegLog: string
}

// ── Clip plan ─────────────────────────────────────────────────────────────────

interface ClipPlan {
  localPath: string
  startOffset: number // seconds into clip to start sampling
  duration: number    // seconds to take from this clip
  clipDuration: number
  hasAudio: boolean
}

/**
 * Decides which section of each clip to use, respecting the brief's pacing.
 *
 * If totalSourceDuration ≤ target + 2s: use every clip in full (no padding).
 *
 * When trimming is needed:
 *   fast   (default for shorts):
 *     Equal slices from the START of each clip.
 *     e.g. 4 clips for 30s → 7.5s from the start of each.
 *
 *   medium:
 *     Equal slices from the MIDDLE of each clip (start at the 25% mark).
 *     Keeps the "interesting" centre of each clip.
 *
 *   slow:
 *     Front-loaded slices: first ⌈N/2⌉ clips get 1.5× budget weight,
 *     remaining clips get 0.7×. All weights are normalised to target.
 *     Effect: first clip(s) run longer, later clips are trimmed harder.
 *
 * Individual clip slices are capped to the clip's actual duration.
 * Scene boundaries from 1A preprocessing are intentionally ignored here;
 * the 1B.9 regenerate slider will use them for smarter selection.
 */
function buildClipPlan(
  clips: Array<{ localPath: string; durationSeconds: number; hasAudio: boolean; words: TranscriptWord[] | null }>,
  target: number,
  pacing: 'fast' | 'medium' | 'slow' | null,
  log: (msg: string) => void,
): ClipPlan[] {
  const N = clips.length
  const totalSrc = clips.reduce((acc, c) => acc + c.durationSeconds, 0)

  // ── Compute raw (pre-snap) offsets ────────────────────────────────────────────

  type RawSlice = { startOffset: number; duration: number }
  let rawSlices: RawSlice[]

  // Under target + 2s tolerance: use every clip full-length, accept the under-run
  if (totalSrc <= target + 2) {
    rawSlices = clips.map((c) => ({ startOffset: 0, duration: c.durationSeconds }))
  } else {
    const p = pacing ?? 'fast'

    if (p === 'fast') {
      const slicePerClip = target / N
      rawSlices = clips.map((c) => ({
        startOffset: 0,
        duration: Math.min(slicePerClip, c.durationSeconds),
      }))
    } else if (p === 'medium') {
      const slicePerClip = target / N
      rawSlices = clips.map((c) => ({
        startOffset: c.durationSeconds * 0.25,
        duration: Math.min(slicePerClip, c.durationSeconds * 0.75),
      }))
    } else {
      // slow: front-loaded weight distribution
      const firstHalfCount = Math.ceil(N / 2)
      const rawWeights = clips.map((_, i) => (i < firstHalfCount ? 1.5 : 0.7))
      const totalWeight = rawWeights.reduce((a, b) => a + b, 0)
      const budgets = rawWeights.map((w) => (w / totalWeight) * target)
      rawSlices = clips.map((c, i) => ({
        startOffset: 0,
        duration: Math.min(budgets[i]!, c.durationSeconds),
      }))
    }
  }

  // ── Apply speech-aware snap ───────────────────────────────────────────────────

  const tolerance = snapToleranceMs(pacing)

  return clips.map((c, i) => {
    const raw = rawSlices[i]!
    const words = c.words

    if (!words || words.length === 0) {
      // No transcript — skip snapping
      return { localPath: c.localPath, startOffset: raw.startOffset, duration: raw.duration, clipDuration: c.durationSeconds, hasAudio: c.hasAudio }
    }

    const desiredStartMs = raw.startOffset * 1000
    const desiredEndMs = (raw.startOffset + raw.duration) * 1000
    const clipDurationMs = c.durationSeconds * 1000

    const snap = snapTrimToSilence(words, desiredStartMs, desiredEndMs, tolerance, clipDurationMs)

    const snappedStartOffset = snap.startMs / 1000
    const snappedDuration = (snap.endMs - snap.startMs) / 1000

    if (snap.startReason !== 'original' || snap.endReason !== 'original') {
      log(
        `  [${i + 1}] snap: start ${snap.startReason}(${snap.startDeltaMs > 0 ? '+' : ''}${snap.startDeltaMs}ms) ` +
          `end ${snap.endReason}(${snap.endDeltaMs > 0 ? '+' : ''}${snap.endDeltaMs}ms)`,
      )
    }

    return {
      localPath: c.localPath,
      startOffset: snappedStartOffset,
      duration: snappedDuration,
      clipDuration: c.durationSeconds,
      hasAudio: c.hasAudio,
    }
  })
}

// ── ffmpeg args builder ───────────────────────────────────────────────────────

/**
 * Builds the complete ffmpeg argument list for a multi-clip 9:16 assembly.
 *
 * Input-level seek (-ss/-t before -i) is used for each clip: it's faster
 * than filter-level trim for H.264 files because ffmpeg can skip to a
 * keyframe without decoding intermediate frames.
 *
 * Per-clip video filter chain:
 *   scale=1080:1920:force_original_aspect_ratio=increase
 *     → zoom to cover 1080×1920 (no black bars, may exceed on one axis)
 *   crop=1080:1920
 *     → center-crop to exact 9:16 (simple, no smart framing — post-1B.5)
 *   fps=30
 *     → normalise frame rate before concat
 *   setpts=PTS-STARTPTS
 *     → reset timestamps so the concat filter sees contiguous PTS
 *
 * Per-clip audio:
 *   Clips with audio  → asetpts=PTS-STARTPTS
 *   Clips without     → anullsrc silence (44100 Hz stereo), trimmed to clip duration
 *
 * Output: libx264 fast/crf23, AAC 44100 stereo, 30fps, faststart.
 */
function buildFfmpegArgs(plan: ClipPlan[], outputPath: string): string[] {
  const args: string[] = []

  // Per-clip inputs with input-level seek
  for (const clip of plan) {
    if (clip.startOffset > 0.001) {
      args.push('-ss', clip.startOffset.toFixed(3))
    }
    args.push('-t', clip.duration.toFixed(3), '-i', clip.localPath)
  }

  // filter_complex
  const filterLines: string[] = []
  const vPads: string[] = []
  const aPads: string[] = []

  for (let i = 0; i < plan.length; i++) {
    const clip = plan[i]!

    const vOut = `[v${i}]`
    filterLines.push(
      `[${i}:v]` +
        `scale=1080:1920:force_original_aspect_ratio=increase,` +
        `crop=1080:1920,fps=30,setpts=PTS-STARTPTS` +
        vOut,
    )
    vPads.push(vOut)

    const aOut = `[a${i}]`
    if (clip.hasAudio) {
      filterLines.push(`[${i}:a]asetpts=PTS-STARTPTS${aOut}`)
    } else {
      // Silent placeholder for clips without an audio stream
      filterLines.push(
        `anullsrc=r=44100:cl=stereo,atrim=duration=${clip.duration.toFixed(3)},asetpts=PTS-STARTPTS${aOut}`,
      )
    }
    aPads.push(aOut)
  }

  // Interleave video + audio pads, then concat
  const concatInputs = vPads.map((v, i) => `${v}${aPads[i]!}`).join('')
  filterLines.push(`${concatInputs}concat=n=${plan.length}:v=1:a=1[outv][outa]`)

  args.push(
    '-filter_complex', filterLines.join(';'),
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-r', '30',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  )

  return args
}

// ── Main assembly function ────────────────────────────────────────────────────

export async function assembleShortFromBrief(
  input: AssemblyInput,
  checkCancelled: () => Promise<void>,
): Promise<AssemblyResult> {
  const { brief, clips, workDir, renderId, log } = input
  const outputPath = join(workDir, 'output.mp4')

  // ── Download normalized clips from R2 ──────────────────────────────────────

  await checkCancelled()

  const downloaded: Array<{ localPath: string; durationSeconds: number; hasAudio: boolean; words: TranscriptWord[] | null }> = []

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!
    const localPath = join(workDir, `clip-${i}.mp4`)

    log(`downloading clip ${i + 1}/${clips.length} — asset ${clip.assetId}`)

    try {
      await getObjectToFile(clip.normalizedR2Key, localPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('ENOSPC') || msg.includes('no space left')) {
        throw new Error('Render worker out of disk — retry shortly')
      }
      // Asset may have been deleted between brief save and render — skip + warn
      log(`WARNING: skipping clip ${i + 1} (asset ${clip.assetId}) — download failed: ${msg}`)
      continue
    }

    // Prefer duration from DB metadata; fall back to ffprobe (costs an extra read)
    const storedDur = clip.durationSeconds != null ? Number(clip.durationSeconds) : 0
    let durationSeconds: number
    if (storedDur > 0) {
      durationSeconds = storedDur
    } else {
      log(`probing duration for clip ${i + 1} (no DB duration)`)
      const probe = await probeVideo(localPath)
      durationSeconds = probe.durationSeconds
    }

    downloaded.push({
      localPath,
      durationSeconds,
      hasAudio: (clip.audioChannels ?? 0) > 0,
      words: (clip.transcriptWordTimestamps as TranscriptWord[] | null) ?? null,
    })
  }

  if (downloaded.length === 0) {
    throw new Error(
      'No preprocessed source clips available — re-upload or wait for preprocessing to complete',
    )
  }

  // ── Build clip plan ────────────────────────────────────────────────────────

  await checkCancelled()

  const plan = buildClipPlan(downloaded, brief.durationSeconds, brief.pacing, log)
  const plannedTotal = plan.reduce((acc, c) => acc + c.duration, 0)

  log(
    `plan: ${plan.length} clip(s), target=${brief.durationSeconds}s, ` +
      `planned=${plannedTotal.toFixed(1)}s, pacing=${brief.pacing ?? 'fast (default)'}`,
  )
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i]!
    log(
      `  [${i + 1}] offset=${p.startOffset.toFixed(2)}s take=${p.duration.toFixed(2)}s ` +
        `of ${p.clipDuration.toFixed(2)}s${p.hasAudio ? '' : ' (no audio)'}`,
    )
  }

  // ── Run ffmpeg ─────────────────────────────────────────────────────────────

  const ffmpegArgs = buildFfmpegArgs(plan, outputPath)
  log(`ffmpeg ${ffmpegArgs.join(' ')}`)

  let ffmpegLog = ''
  try {
    const { stderr } = await execFileAsync('ffmpeg', ffmpegArgs, {
      timeout: RENDER_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    })
    ffmpegLog = stderr ?? ''
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string }
    const stderrTail = (e.stderr ?? '').slice(-2048)

    if (e.killed || e.signal === 'SIGTERM' || String(e.code) === 'ETIMEDOUT') {
      throw new Error(`ffmpeg timed out after ${RENDER_TIMEOUT_MS / 1000}s`)
    }
    if (e.message?.includes('ENOSPC') || stderrTail.includes('No space left')) {
      throw new Error('Render worker out of disk — retry shortly')
    }
    throw new Error(`ffmpeg failed:\n${stderrTail || e.message}`)
  }

  // ── Verify output duration ─────────────────────────────────────────────────

  let actualDurationSeconds = plannedTotal
  try {
    const probe = await probeVideo(outputPath)
    actualDurationSeconds = probe.durationSeconds

    const delta = Math.abs(actualDurationSeconds - brief.durationSeconds)
    if (delta > 2 && plannedTotal > brief.durationSeconds) {
      log(
        `WARNING: output ${actualDurationSeconds.toFixed(2)}s differs from ` +
          `target ${brief.durationSeconds}s by ${delta.toFixed(2)}s (>2s tolerance)`,
      )
    }
  } catch {
    log('WARNING: could not probe output duration — using planned total')
  }

  const { size: outputSizeBytes } = await stat(outputPath)
  log(
    `done: ${actualDurationSeconds.toFixed(2)}s, ${(outputSizeBytes / 1_048_576).toFixed(1)}MB`,
  )

  return {
    outputPath,
    actualDurationSeconds,
    sourceClipCount: downloaded.length,
    ffmpegLog: ffmpegLog.slice(-4096),
  }
}
