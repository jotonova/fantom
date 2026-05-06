import { createRequire } from 'node:module'
import Ffmpeg from 'fluent-ffmpeg'

// ffmpeg-static is CJS; use createRequire so NodeNext module resolution finds it
const _require = createRequire(import.meta.url)
const ffmpegBinary = _require('ffmpeg-static') as string | null
if (ffmpegBinary) Ffmpeg.setFfmpegPath(ffmpegBinary)

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SceneDetectionResult {
  sceneCount: number
  /** Float seconds where each new scene starts. Always includes 0.0 as first entry. */
  sceneBoundaries: number[]
}

// ── detectScenes ──────────────────────────────────────────────────────────────

/**
 * Detects scene boundaries in a video using ffmpeg's scene filter.
 *
 * Runs: ffmpeg -i <input> -vf "select='gt(scene,<sensitivity>)',showinfo" -f null -
 * Parses pts_time values from showinfo stderr output.
 *
 * @param localPath      Absolute path to the local video file
 * @param durationSeconds  Video duration — clips < 2s are skipped
 * @param sensitivity    ffmpeg scene threshold, 0.0–1.0 (default 0.4)
 */
export function detectScenes(
  localPath: string,
  durationSeconds: number,
  sensitivity = 0.4,
): Promise<SceneDetectionResult> {
  // Skip detection for very short clips
  if (durationSeconds < 2) {
    return Promise.resolve({ sceneCount: 1, sceneBoundaries: [0.0] })
  }

  return new Promise((resolve, reject) => {
    const changeTimes: number[] = []

    Ffmpeg(localPath)
      .outputOptions([
        `-vf`, `select='gt(scene,${sensitivity})',showinfo`,
        `-f`, `null`,
      ])
      .output('-')
      .on('stderr', (line: string) => {
        // showinfo emits lines like:
        //   [Parsed_showinfo_1 @ 0x...] n:  5 pts: 123 pts_time:5.125 ...
        if (line.includes('Parsed_showinfo')) {
          const match = line.match(/pts_time:(\d+(?:\.\d+)?)/)
          if (match?.[1] != null) {
            const t = parseFloat(match[1])
            if (!isNaN(t) && t > 0) {
              changeTimes.push(t)
            }
          }
        }
      })
      .on('end', () => {
        // Sort and deduplicate (shouldn't be needed, but defensive)
        const boundaries = [0.0, ...changeTimes].sort((a, b) => a - b)
        resolve({ sceneCount: boundaries.length, sceneBoundaries: boundaries })
      })
      .on('error', (err: Error) => {
        reject(new Error(`Scene detection failed: ${err.message}`))
      })
      .run()
  })
}
