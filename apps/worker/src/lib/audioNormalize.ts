import { createRequire } from 'node:module'
import Ffmpeg from 'fluent-ffmpeg'

const _require = createRequire(import.meta.url)
const ffmpegBinary = _require('ffmpeg-static') as string | null
if (ffmpegBinary) Ffmpeg.setFfmpegPath(ffmpegBinary)

// ── Constants ─────────────────────────────────────────────────────────────────

/** EBU R128 single-pass loudnorm filter targeting -16 LUFS / -1.5 dBTP / LRA 11 */
export const AUDIO_NORMALIZE_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoudnessMeasurement {
  integratedLufs: number
  truePeakDb: number
}

// ── measureLoudness ───────────────────────────────────────────────────────────

/**
 * Measures the integrated loudness and true peak of a local audio/video file
 * by running a single ffmpeg loudnorm pass with print_format=json.
 *
 * Edge case: silent/no-audio source returns { integratedLufs: -Infinity, truePeakDb: -Infinity }.
 */
export function measureLoudness(localPath: string): Promise<LoudnessMeasurement> {
  return new Promise((resolve) => {
    const stderrLines: string[] = []

    Ffmpeg(localPath)
      .outputOptions([
        '-af', 'loudnorm=print_format=json',
        '-f', 'null',
      ])
      .output('-')
      .on('stderr', (line: string) => {
        stderrLines.push(line)
      })
      .on('end', () => {
        // loudnorm prints a JSON block to stderr at the end of the pass
        const joined = stderrLines.join('\n')
        const jsonMatch = joined.match(/\{[\s\S]*?"input_i"\s*:[\s\S]*?\}/)
        if (!jsonMatch) {
          // No audio or parse failure — return -Infinity
          resolve({ integratedLufs: -Infinity, truePeakDb: -Infinity })
          return
        }
        try {
          const parsed = JSON.parse(jsonMatch[0]) as Record<string, string>
          const integratedLufs = parseFloat(parsed['input_i'] ?? 'NaN')
          const truePeakDb = parseFloat(parsed['input_tp'] ?? 'NaN')
          resolve({
            integratedLufs: isFinite(integratedLufs) ? integratedLufs : -Infinity,
            truePeakDb: isFinite(truePeakDb) ? truePeakDb : -Infinity,
          })
        } catch {
          resolve({ integratedLufs: -Infinity, truePeakDb: -Infinity })
        }
      })
      .on('error', () => {
        // Measurement failure is non-fatal — silent or no-audio source
        resolve({ integratedLufs: -Infinity, truePeakDb: -Infinity })
      })
      .run()
  })
}
