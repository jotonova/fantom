import { createRequire } from 'node:module'
import Ffmpeg from 'fluent-ffmpeg'

// ffprobe-static is CJS; use createRequire so NodeNext module resolution finds it
const _require = createRequire(import.meta.url)
const ffmpegBinary = _require('ffmpeg-static') as string | null
if (ffmpegBinary) Ffmpeg.setFfmpegPath(ffmpegBinary)

// ── generateThumbnail ─────────────────────────────────────────────────────────

/**
 * Extracts a single JPEG frame from a video at 10% of its duration.
 * Output is scaled to 1280px wide (maintaining aspect ratio), JPEG quality ~80.
 *
 * @param localPath     Absolute path to the source video file
 * @param outputPath    Absolute path for the output JPEG (e.g. /tmp/thumb.jpg)
 * @param durationSeconds  Total video duration — used to compute the seek offset
 */
export function generateThumbnail(
  localPath: string,
  outputPath: string,
  durationSeconds: number,
): Promise<void> {
  // Seek to 10% of the video; clamp to [1, duration - 1] for very short clips
  const seekSeconds = Math.max(1, Math.min(durationSeconds * 0.1, durationSeconds - 1))

  return new Promise((resolve, reject) => {
    Ffmpeg(localPath)
      .inputOptions([`-ss ${seekSeconds.toFixed(3)}`])
      .outputOptions([
        '-vframes 1',
        '-vf scale=1280:-2',   // 1280px wide, height divisible by 2
        '-q:v 4',              // JPEG quality scale: 1=best, 31=worst; 4 ≈ q80
        '-f image2',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`Thumbnail generation failed: ${err.message}`)))
      .run()
  })
}
