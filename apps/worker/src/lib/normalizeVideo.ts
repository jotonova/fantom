import { createRequire } from 'node:module'
import { stat } from 'node:fs/promises'
import Ffmpeg from 'fluent-ffmpeg'
import { AUTO_COLOR_FILTER } from './colorCorrect.js'
import { AUDIO_NORMALIZE_FILTER } from './audioNormalize.js'

const _require = createRequire(import.meta.url)
const ffmpegBinary = _require('ffmpeg-static') as string | null
if (ffmpegBinary) Ffmpeg.setFfmpegPath(ffmpegBinary)

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NormalizeResult {
  outputPath: string
  sizeBytes: number
  videoCodec: 'h264'
  audioCodec: 'aac' | null
  width: number
  height: number
}

// ── Scale filter ──────────────────────────────────────────────────────────────

/**
 * Builds a scale filter string that downscales to 1080p (shorter dimension)
 * while preserving aspect ratio. Never upscales.
 *
 * - Landscape (w > h): scale height to 1080, width auto-rounded to even
 * - Portrait  (w < h): scale width to 1080, height auto-rounded to even
 * - Square / already ≤ 1080p: no scale applied
 *
 * libx264 requires even dimensions; -2 means "auto, round to nearest even".
 */
function buildScaleFilter(sourceWidth: number, sourceHeight: number): string | null {
  const shorter = Math.min(sourceWidth, sourceHeight)
  if (shorter <= 1080) return null // already 1080p or smaller — no scale

  // Scale shorter dimension to 1080; the -2 lets ffmpeg compute the other
  // dimension while rounding to an even number.
  return `scale='if(gt(iw,ih),-2,1080)':'if(gt(iw,ih),1080,-2)'`
}

/**
 * Computes expected output dimensions after 1080p downscale.
 * Returns source dims unchanged if no downscale is needed.
 */
function computeOutputDimensions(
  sourceWidth: number,
  sourceHeight: number,
): { width: number; height: number } {
  const shorter = Math.min(sourceWidth, sourceHeight)
  if (shorter <= 1080) return { width: sourceWidth, height: sourceHeight }

  const ratio = 1080 / shorter
  // Round to nearest even
  const w = Math.round((sourceWidth * ratio) / 2) * 2
  const h = Math.round((sourceHeight * ratio) / 2) * 2
  return { width: w, height: h }
}

// ── normalizeVideo ────────────────────────────────────────────────────────────

/**
 * Transcodes a video to H.264/AAC with auto color correction and EBU R128
 * audio normalization in a single ffmpeg pass.
 *
 * - Downscaled to 1080p (shorter dim) if source exceeds 1080p
 * - Video: libx264, preset fast, CRF 21, yuv420p, faststart, 2 threads
 * - Audio: AAC 192k + loudnorm (only if hasAudio)
 */
export function normalizeVideo(
  inputPath: string,
  outputPath: string,
  hasAudio: boolean,
  sourceWidth: number,
  sourceHeight: number,
  log: (msg: string) => void,
): Promise<NormalizeResult> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const dims = computeOutputDimensions(sourceWidth, sourceHeight)
    const scaleFilter = buildScaleFilter(sourceWidth, sourceHeight)

    log(`normalize start — source ${sourceWidth}×${sourceHeight} → output ${dims.width}×${dims.height} (hasAudio=${hasAudio})`)

    // Build video filter chain: [scale,]color
    const vfFilters: string[] = []
    if (scaleFilter) vfFilters.push(scaleFilter)
    vfFilters.push(AUTO_COLOR_FILTER)

    const cmd = Ffmpeg(inputPath)
      .videoFilters(vfFilters)
      .videoCodec('libx264')
      .outputOptions([
        '-preset', 'fast',
        '-crf', '21',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-threads', '2',
      ])

    if (hasAudio) {
      cmd.audioFilters(AUDIO_NORMALIZE_FILTER)
      cmd.audioCodec('aac')
      cmd.audioBitrate('192k')
    } else {
      cmd.noAudio()
    }

    cmd
      .output(outputPath)
      .on('end', async () => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
        log(`normalize complete (${elapsed}s) — ${dims.width}×${dims.height}`)
        try {
          const { size } = await stat(outputPath)
          resolve({
            outputPath,
            sizeBytes: size,
            videoCodec: 'h264',
            audioCodec: hasAudio ? 'aac' : null,
            width: dims.width,
            height: dims.height,
          })
        } catch (err) {
          reject(new Error(`Failed to stat normalized output: ${err instanceof Error ? err.message : String(err)}`))
        }
      })
      .on('error', (err: Error) => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
        log(`normalize failed after ${elapsed}s: ${err.message}`)
        reject(new Error(`Video normalization failed: ${err.message}`))
      })
      .run()
  })
}
