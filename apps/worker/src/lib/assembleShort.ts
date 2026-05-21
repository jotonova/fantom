/**
 * assembleShortFromBrief — 1B.9.1 scene-aware density assembly engine
 *
 * Extends the 1B.5 assembly engine with density-driven scene subdivision.
 * Each source clip is split into candidate segments at its scene_boundaries;
 * density controls how many segments are drawn into the final assembly:
 *
 *   low    — whole-clip segments only, few cuts (same cut count as today)
 *   medium — one representative segment per clip (matches 1B.5 baseline)
 *   high   — all scene-boundary segments; time-division fallback when a clip
 *             has no interior boundaries so HIGH always produces more cuts
 *
 * Pacing (fast/medium/slow) still controls WHICH representative segment is
 * chosen per clip in 'low' and 'medium' density, and snap tolerance. They
 * compose: pacing = rhythm feel, density = cut frequency.
 *
 * All cut points pass through snapCuts.ts speech-aware silence/sentence
 * snapping before being committed to the ffmpeg plan.
 *
 * VO and caption alignment (clipStartTimes / clipTrimStartTimes) remain
 * per-source-clip so the 1B.6–1B.8 pipeline requires no changes. The first
 * segment from each clip anchors its clip-level timeline position.
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

// When no interior scene boundaries exist, HIGH density subdivides each clip
// into equal time slices targeting this many seconds per sub-segment.
const HIGH_FALLBACK_SEGMENT_S = 5

// Minimum segment duration: shorter segments are dropped to avoid ffmpeg issues.
const MIN_SEGMENT_S = 1.0

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SourceClipInput {
  assetId: string
  normalizedR2Key: string
  /** Drizzle returns numeric columns as strings — accept either */
  durationSeconds: string | number | null
  audioChannels: number | null
  /** Word timestamps from AssemblyAI preprocessing; null if not yet transcribed */
  transcriptWordTimestamps: TranscriptWord[] | null
  /** Scene change timestamps (seconds) from 1A preprocessing. [0] = single scene. */
  sceneBoundaries: number[] | null
}

export interface AssemblyInput {
  brief: {
    durationSeconds: number
    pacing: 'fast' | 'medium' | 'slow' | null
    density: 'low' | 'medium' | 'high' | null
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
  /** Start time of each SOURCE CLIP's first segment in the assembled video (seconds).
   *  clipStartTimes[0] = 0. Per-clip (not per-segment) so VO/caption alignment is unchanged. */
  clipStartTimes: number[]
  /** Total planned playout duration of all segments from each source clip (seconds). */
  clipDurations: number[]
  /** Trim start of each source clip's first segment in the source asset (seconds).
   *  Used to align source-relative AssemblyAI transcript timestamps. */
  clipTrimStartTimes: number[]
}

// ── Internal types ────────────────────────────────────────────────────────────

/** A candidate segment extracted from a single source clip. */
interface ClipSegment {
  clipIndex: number       // index into the `downloaded` array
  startInClip: number     // seconds: start offset within source clip
  endInClip: number       // seconds: end offset within source clip
  naturalDuration: number // = endInClip - startInClip
}

/** Final plan entry fed to buildFfmpegArgs and used for timeline math. */
interface ClipPlan {
  localPath: string
  startOffset: number  // seconds into source clip to begin sampling
  duration: number     // seconds to sample from this position
  clipDuration: number // total source clip duration (for ffmpeg input-seek cap)
  hasAudio: boolean
  clipIndex: number    // which source clip this segment came from
}

// ── Segment subdivision ───────────────────────────────────────────────────────

/**
 * Converts a clip's scene_boundaries into a list of non-overlapping segments.
 * The boundary array always starts with 0 (the first scene); additional values
 * are the seconds at which a new scene starts.
 *
 * Returns segments in order. Each segment is at least MIN_SEGMENT_S long.
 * If boundaries is null or [0] (single scene), returns one segment = whole clip.
 */
function expandToSegments(clipIndex: number, dur: number, boundaries: number[] | null): ClipSegment[] {
  const hasInterior = boundaries != null && boundaries.length > 1

  if (!hasInterior) {
    return [{ clipIndex, startInClip: 0, endInClip: dur, naturalDuration: dur }]
  }

  // Normalise: deduplicate, sort, clamp to [0, dur)
  const pts = [...new Set([0, ...boundaries.filter((b) => b > 0 && b < dur)])].sort((a, b) => a - b)

  const segs: ClipSegment[] = []
  for (let i = 0; i < pts.length; i++) {
    const s = pts[i]!
    const e = i + 1 < pts.length ? pts[i + 1]! : dur
    const len = e - s
    if (len >= MIN_SEGMENT_S) {
      segs.push({ clipIndex, startInClip: s, endInClip: e, naturalDuration: len })
    }
  }
  if (segs.length === 0) {
    segs.push({ clipIndex, startInClip: 0, endInClip: dur, naturalDuration: dur })
  }
  return segs
}

/**
 * Builds the HIGH-density time-division fallback for clips with no interior
 * scene boundaries. Splits the clip into N equal sub-segments where
 * N = ceil(dur / HIGH_FALLBACK_SEGMENT_S) and N ≥ 2.
 */
function timeDivisionSegments(clipIndex: number, dur: number): ClipSegment[] {
  const N = Math.max(2, Math.ceil(dur / HIGH_FALLBACK_SEGMENT_S))
  const segDur = dur / N
  const segs: ClipSegment[] = []
  for (let i = 0; i < N; i++) {
    const s = i * segDur
    const e = Math.min((i + 1) * segDur, dur)
    const len = e - s
    if (len >= MIN_SEGMENT_S) {
      segs.push({ clipIndex, startInClip: s, endInClip: e, naturalDuration: len })
    }
  }
  return segs.length > 0 ? segs : [{ clipIndex, startInClip: 0, endInClip: dur, naturalDuration: dur }]
}

/**
 * Selects segments from each clip according to density and pacing.
 *
 *   low    — whole clip as one segment (ignore interior boundaries). Pacing controls
 *            the START position within that single segment (via budget scaling later).
 *   medium — one representative segment per clip, chosen by pacing:
 *              fast/null → first segment
 *              medium    → segment containing the 25% mark
 *              slow      → longest segment
 *   high   — all segments when interior boundaries exist;
 *            time-division fallback (N ≥ 2 sub-segments) when they don't.
 */
function selectSegments(
  clipIndex: number,
  dur: number,
  boundaries: number[] | null,
  density: 'low' | 'medium' | 'high',
  pacing: 'fast' | 'medium' | 'slow' | null,
): ClipSegment[] {
  if (density === 'low') {
    return [{ clipIndex, startInClip: 0, endInClip: dur, naturalDuration: dur }]
  }

  const naturalSegs = expandToSegments(clipIndex, dur, boundaries)

  if (density === 'medium') {
    if (naturalSegs.length === 1) return naturalSegs
    const p = pacing ?? 'fast'
    if (p === 'fast') {
      return [naturalSegs[0]!]
    } else if (p === 'medium') {
      // segment containing the 25% mark
      const target25 = dur * 0.25
      const idx = naturalSegs.findIndex((s) => s.endInClip > target25)
      return [naturalSegs[Math.max(0, idx)]!]
    } else {
      // slow: longest segment
      const longest = naturalSegs.reduce((best, s) => s.naturalDuration > best.naturalDuration ? s : best)
      return [longest]
    }
  }

  // high
  const hasInterior = boundaries != null && boundaries.length > 1
  if (!hasInterior) {
    return timeDivisionSegments(clipIndex, dur)
  }
  return naturalSegs
}

// ── Clip plan (segment model) ─────────────────────────────────────────────────

/**
 * Builds the ffmpeg plan from all selected segments across all clips.
 *
 * Budget allocation: total natural duration of all segments is scaled to
 * `target` proportionally. LOW density uses pacing-based start offsets
 * within the whole-clip segment (matching 1B.5 pacing behaviour exactly).
 *
 * Speech-aware snapping (snapCuts.ts) is applied to each segment's
 * start/end within the source clip time coordinate system.
 */
function buildSegmentPlan(
  clips: Array<{
    localPath: string
    durationSeconds: number
    hasAudio: boolean
    words: TranscriptWord[] | null
    sceneBoundaries: number[] | null
  }>,
  target: number,
  pacing: 'fast' | 'medium' | 'slow' | null,
  density: 'low' | 'medium' | 'high',
  log: (msg: string) => void,
): ClipPlan[] {
  const N = clips.length
  const p = pacing ?? 'fast'

  // ── Step 1: Select candidate segments ──────────────────────────────────────

  const allSegments: ClipSegment[] = []
  for (let i = 0; i < N; i++) {
    const clip = clips[i]!
    const selected = selectSegments(i, clip.durationSeconds, clip.sceneBoundaries, density, pacing)
    allSegments.push(...selected)
  }

  const totalSegments = allSegments.length
  const totalNatural = allSegments.reduce((acc, s) => acc + s.naturalDuration, 0)

  log(
    `density=${density} pacing=${p}: ${N} clip(s) → ${totalSegments} segment(s), ` +
      `natural=${totalNatural.toFixed(1)}s, target=${target}s`,
  )

  // ── Step 2: Assign budgeted durations ──────────────────────────────────────
  //
  // For LOW density with pacing, we apply the same start-offset model as the
  // original 1B.5 buildClipPlan — each whole-clip segment uses a pacing-driven
  // startOffset within its natural range. For MEDIUM and HIGH, the segment
  // boundaries are already scene-aware; we take from the segment's startInClip.

  type RawSlice = { startOffset: number; duration: number }
  let rawSlices: RawSlice[]

  if (density === 'low') {
    // Mirror original buildClipPlan pacing logic applied to whole-clip segments.
    // totalSrc = totalNatural (all segments are whole clips for LOW).
    if (totalNatural <= target + 2) {
      rawSlices = allSegments.map((s) => ({ startOffset: 0, duration: s.naturalDuration }))
    } else if (p === 'fast') {
      const slicePerClip = target / N
      rawSlices = allSegments.map((s) => ({
        startOffset: 0,
        duration: Math.min(slicePerClip, s.naturalDuration),
      }))
    } else if (p === 'medium') {
      const slicePerClip = target / N
      rawSlices = allSegments.map((s) => ({
        startOffset: s.naturalDuration * 0.25,
        duration: Math.min(slicePerClip, s.naturalDuration * 0.75),
      }))
    } else {
      // slow: front-loaded weights across clips
      const firstHalfCount = Math.ceil(N / 2)
      const rawWeights = allSegments.map((_, i) => (i < firstHalfCount ? 1.5 : 0.7))
      const totalWeight = rawWeights.reduce((a, b) => a + b, 0)
      const budgets = rawWeights.map((w) => (w / totalWeight) * target)
      rawSlices = allSegments.map((s, i) => ({
        startOffset: 0,
        duration: Math.min(budgets[i]!, s.naturalDuration),
      }))
    }
  } else {
    // MEDIUM and HIGH: take from segment start (scene-boundary-aligned).
    // Scale all segment durations proportionally to fill target.
    if (totalNatural <= target + 2) {
      rawSlices = allSegments.map((s) => ({ startOffset: s.startInClip, duration: s.naturalDuration }))
    } else {
      const scale = target / totalNatural
      rawSlices = allSegments.map((s) => ({
        startOffset: s.startInClip,
        duration: Math.min(s.naturalDuration * scale, s.naturalDuration),
      }))
    }
  }

  // ── Step 3: Apply speech-aware snapping ───────────────────────────────────

  const tolerance = snapToleranceMs(pacing)

  return allSegments.map((seg, i) => {
    const clip = clips[seg.clipIndex]!
    const raw = rawSlices[i]!
    const words = clip.words

    // For LOW density, raw.startOffset is pacing-driven (0, 25%, etc.).
    // For MEDIUM/HIGH, raw.startOffset = seg.startInClip (scene boundary).
    const desiredStartMs = raw.startOffset * 1000
    const desiredEndMs = (raw.startOffset + raw.duration) * 1000
    const clipDurationMs = clip.durationSeconds * 1000

    if (!words || words.length === 0) {
      return {
        localPath: clip.localPath,
        startOffset: raw.startOffset,
        duration: raw.duration,
        clipDuration: clip.durationSeconds,
        hasAudio: clip.hasAudio,
        clipIndex: seg.clipIndex,
      }
    }

    const snap = snapTrimToSilence(words, desiredStartMs, desiredEndMs, tolerance, clipDurationMs)

    if (snap.startReason !== 'original' || snap.endReason !== 'original') {
      log(
        `  [clip${seg.clipIndex + 1} seg${i + 1}] snap: ` +
          `start ${snap.startReason}(${snap.startDeltaMs > 0 ? '+' : ''}${snap.startDeltaMs}ms) ` +
          `end ${snap.endReason}(${snap.endDeltaMs > 0 ? '+' : ''}${snap.endDeltaMs}ms)`,
      )
    }

    return {
      localPath: clip.localPath,
      startOffset: snap.startMs / 1000,
      duration: (snap.endMs - snap.startMs) / 1000,
      clipDuration: clip.durationSeconds,
      hasAudio: clip.hasAudio,
      clipIndex: seg.clipIndex,
    }
  })
}

// ── ffmpeg args builder ───────────────────────────────────────────────────────

/**
 * Builds the complete ffmpeg argument list for a multi-segment 9:16 assembly.
 *
 * Input-level seek (-ss/-t before -i) is used for each segment: faster than
 * filter-level trim for H.264 because ffmpeg can skip to a keyframe.
 * Multiple segments from the same source file appear as separate -i inputs —
 * ffmpeg handles this correctly.
 *
 * Per-segment video filter chain:
 *   scale=1080:1920:force_original_aspect_ratio=increase → cover 1080×1920
 *   crop=1080:1920                                       → center-crop 9:16
 *   fps=30                                               → normalise frame rate
 *   setpts=PTS-STARTPTS                                  → reset timestamps for concat
 *
 * Per-segment audio:
 *   With audio    → asetpts=PTS-STARTPTS
 *   Without audio → anullsrc silence trimmed to segment duration
 *
 * Output: libx264 fast/crf23, AAC 44100 stereo, 30fps, faststart.
 */
function buildFfmpegArgs(plan: ClipPlan[], outputPath: string): string[] {
  const args: string[] = []

  for (const seg of plan) {
    if (seg.startOffset > 0.001) {
      args.push('-ss', seg.startOffset.toFixed(3))
    }
    args.push('-t', seg.duration.toFixed(3), '-i', seg.localPath)
  }

  const filterLines: string[] = []
  const vPads: string[] = []
  const aPads: string[] = []

  for (let i = 0; i < plan.length; i++) {
    const seg = plan[i]!

    const vOut = `[v${i}]`
    filterLines.push(
      `[${i}:v]` +
        `scale=1080:1920:force_original_aspect_ratio=increase,` +
        `crop=1080:1920,fps=30,setpts=PTS-STARTPTS` +
        vOut,
    )
    vPads.push(vOut)

    const aOut = `[a${i}]`
    if (seg.hasAudio) {
      filterLines.push(`[${i}:a]asetpts=PTS-STARTPTS${aOut}`)
    } else {
      filterLines.push(
        `anullsrc=r=44100:cl=stereo,atrim=duration=${seg.duration.toFixed(3)},asetpts=PTS-STARTPTS${aOut}`,
      )
    }
    aPads.push(aOut)
  }

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
  const density = brief.density ?? 'medium'

  // ── Download normalized clips from R2 ──────────────────────────────────────

  await checkCancelled()

  const downloaded: Array<{
    localPath: string
    durationSeconds: number
    hasAudio: boolean
    words: TranscriptWord[] | null
    sceneBoundaries: number[] | null
  }> = []

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
      log(`WARNING: skipping clip ${i + 1} (asset ${clip.assetId}) — download failed: ${msg}`)
      continue
    }

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
      sceneBoundaries: clip.sceneBoundaries,
    })
  }

  if (downloaded.length === 0) {
    throw new Error(
      'No preprocessed source clips available — re-upload or wait for preprocessing to complete',
    )
  }

  // ── Build segment plan ─────────────────────────────────────────────────────

  await checkCancelled()

  const plan = buildSegmentPlan(downloaded, brief.durationSeconds, brief.pacing, density, log)
  const plannedTotal = plan.reduce((acc, c) => acc + c.duration, 0)

  // ── Compute per-clip timeline anchors (for VO + caption alignment) ──────────
  //
  // VO and captions remain 1:1 per source clip (not per segment). The first
  // segment from each clip anchors its clip-level start time in the video.
  // clipDurations[i] = total of all segments from clip i.

  const planSegmentStarts: number[] = []
  let planCumulative = 0
  for (const seg of plan) {
    planSegmentStarts.push(planCumulative)
    planCumulative += seg.duration
  }

  const clipFirstStart = new Array<number>(downloaded.length).fill(-1)
  const clipFirstTrim = new Array<number>(downloaded.length).fill(0)
  const clipTotalDuration = new Array<number>(downloaded.length).fill(0)

  for (let pi = 0; pi < plan.length; pi++) {
    const seg = plan[pi]!
    const ci = seg.clipIndex
    clipTotalDuration[ci] = (clipTotalDuration[ci] ?? 0) + seg.duration
    if (clipFirstStart[ci] === -1) {
      clipFirstStart[ci] = planSegmentStarts[pi]!
      clipFirstTrim[ci] = seg.startOffset
    }
  }

  const clipStartTimes = clipFirstStart.map((t) => (t === -1 ? 0 : t))
  const clipDurations = clipTotalDuration
  const clipTrimStartTimes = clipFirstTrim

  log(
    `plan: ${downloaded.length} clip(s), ${plan.length} segment(s), ` +
      `target=${brief.durationSeconds}s, planned=${plannedTotal.toFixed(1)}s, ` +
      `density=${density} pacing=${brief.pacing ?? 'fast (default)'}`,
  )
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i]!
    log(
      `  [clip${p.clipIndex + 1} seg${i + 1}] ` +
        `offset=${p.startOffset.toFixed(2)}s take=${p.duration.toFixed(2)}s ` +
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
      killSignal: 'SIGKILL',
      maxBuffer: 10 * 1024 * 1024,
    })
    ffmpegLog = stderr ?? ''
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string }
    const stderrTail = (e.stderr ?? '').slice(-2048)

    if (e.killed || e.signal === 'SIGTERM' || e.signal === 'SIGKILL' || String(e.code) === 'ETIMEDOUT') {
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
    `done: ${actualDurationSeconds.toFixed(2)}s, ${(outputSizeBytes / 1_048_576).toFixed(1)}MB, ` +
      `${plan.length} segment(s) from ${downloaded.length} clip(s)`,
  )

  return {
    outputPath,
    actualDurationSeconds,
    sourceClipCount: downloaded.length,
    ffmpegLog: ffmpegLog.slice(-4096),
    clipStartTimes,
    clipDurations,
    clipTrimStartTimes,
  }
}
