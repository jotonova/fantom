import { createRequire } from 'node:module'
import Ffmpeg from 'fluent-ffmpeg'

// ffprobe-static is CJS; use createRequire so NodeNext module resolution finds it
const _require = createRequire(import.meta.url)
const ffprobeBinary = _require('ffprobe-static') as string | null
if (ffprobeBinary) Ffmpeg.setFfprobePath(ffprobeBinary)

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VideoProbeResult {
  codec: string
  width: number
  height: number
  durationSeconds: number
  fps: number
  bitrateKbps: number
  audioChannels: number | null
  audioCodec: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parses an ffprobe r_frame_rate string (e.g. "30000/1001", "30/1") to fps.
 */
function parseFrameRate(rFrameRate: string | undefined): number {
  if (!rFrameRate) return 0
  const parts = rFrameRate.split('/')
  if (parts.length !== 2) return parseFloat(rFrameRate) || 0
  const num = parseFloat(parts[0] ?? '0')
  const den = parseFloat(parts[1] ?? '1')
  return den > 0 ? num / den : 0
}

// ── probeVideo ────────────────────────────────────────────────────────────────

/**
 * Extracts video metadata from a local file using ffprobe.
 */
export function probeVideo(localPath: string): Promise<VideoProbeResult> {
  return new Promise((resolve, reject) => {
    Ffmpeg.ffprobe(localPath, (err, metadata) => {
      if (err) {
        reject(new Error(`ffprobe failed: ${err.message}`))
        return
      }

      const videoStream = metadata.streams.find((s) => s.codec_type === 'video')
      const audioStream = metadata.streams.find((s) => s.codec_type === 'audio')

      if (!videoStream) {
        reject(new Error('No video stream found in file'))
        return
      }

      const durationSeconds =
        metadata.format?.duration ??
        (videoStream.duration ? parseFloat(String(videoStream.duration)) : 0)

      const bitrateKbps = metadata.format?.bit_rate
        ? Math.round(Number(metadata.format.bit_rate) / 1000)
        : 0

      resolve({
        codec: videoStream.codec_name ?? 'unknown',
        width: videoStream.width ?? 0,
        height: videoStream.height ?? 0,
        durationSeconds,
        fps: parseFrameRate(videoStream.r_frame_rate),
        bitrateKbps,
        audioChannels: audioStream?.channels ?? null,
        audioCodec: audioStream?.codec_name ?? null,
      })
    })
  })
}
