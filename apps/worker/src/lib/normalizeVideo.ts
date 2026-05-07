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
}

// ── normalizeVideo ────────────────────────────────────────────────────────────

/**
 * Transcodes a video to H.264/AAC with auto color correction and EBU R128
 * audio normalization in a single ffmpeg pass.
 *
 * - Video: libx264, preset medium, CRF 20, yuv420p, faststart
 * - Audio: AAC 192k + loudnorm (only if hasAudio)
 * - Source resolution and framerate are preserved
 */
export function normalizeVideo(
  inputPath: string,
  outputPath: string,
  hasAudio: boolean,
  log: (msg: string) => void,
): Promise<NormalizeResult> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    log(`normalize start (hasAudio=${hasAudio})`)

    const cmd = Ffmpeg(inputPath)
      .videoFilters(AUTO_COLOR_FILTER)
      .videoCodec('libx264')
      .outputOptions([
        '-preset', 'medium',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
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
        log(`normalize complete (${elapsed}s)`)
        try {
          const { size } = await stat(outputPath)
          resolve({
            outputPath,
            sizeBytes: size,
            videoCodec: 'h264',
            audioCodec: hasAudio ? 'aac' : null,
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
