import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Format a duration in seconds as an SRT timecode: HH:MM:SS,mmm */
function toSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.round((seconds % 1) * 1000)
  return (
    String(h).padStart(2, '0') +
    ':' +
    String(m).padStart(2, '0') +
    ':' +
    String(s).padStart(2, '0') +
    ',' +
    String(ms).padStart(3, '0')
  )
}

/**
 * Write a temporary SRT subtitle file from caption_text.
 *
 * Segments are delimited by newlines. A single line (no newlines) produces
 * one entry spanning the full voiceDuration. Returns null if captionText
 * is empty/null. The caller must add the returned path to its tempFiles
 * list so it is cleaned up after the render (success or failure).
 */
export async function generateSrtFile(
  captionText: string | null | undefined,
  jobId: string,
  voiceDuration: number,
): Promise<string | null> {
  const segments = (captionText ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  if (segments.length === 0) return null

  const segDur = voiceDuration / segments.length
  const lines: string[] = []

  for (let i = 0; i < segments.length; i++) {
    const start = i * segDur
    const end = (i + 1) * segDur
    lines.push(`${i + 1}`)
    lines.push(`${toSrtTime(start)} --> ${toSrtTime(end)}`)
    lines.push(segments[i]!)
    lines.push('')
  }

  const srtPath = join(tmpdir(), `captions-${jobId}.srt`)
  await fs.writeFile(srtPath, lines.join('\n'), 'utf8')
  return srtPath
}
