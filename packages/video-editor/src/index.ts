import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Ffmpeg from 'fluent-ffmpeg'

const execFileAsync = promisify(execFile)
const _require = createRequire(import.meta.url)
const ffmpegBinary = _require('ffmpeg-static') as string | null
if (ffmpegBinary) Ffmpeg.setFfmpegPath(ffmpegBinary)

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CutPoint {
  timeSeconds: number
  /** Scene-change score 0–1. Always 1.0 for ffmpeg showinfo output. */
  score: number
}

export interface Transcript {
  text: string
  words?: Array<{ text: string; start: number; end: number; confidence: number }>
  provider: 'assemblyai' | 'whisper'
}

export type ColorGradePreset = 'natural' | 'vivid' | 'cinematic' | 'warm' | 'cool'

// ── analyzeVideoForCutPoints ───────────────────────────────────────────────────

/**
 * Uses ffprobe/ffmpeg scene-change detection to identify good cut points in a video.
 * Returns cut-point timestamps sorted ascending.
 */
export function analyzeVideoForCutPoints(
  videoPath: string,
  opts: { threshold?: number } = {},
): Promise<CutPoint[]> {
  const threshold = opts.threshold ?? 0.3
  const cutPoints: CutPoint[] = []

  return new Promise((resolve, reject) => {
    // Use ffmpeg with select+showinfo to detect scene changes
    Ffmpeg(videoPath)
      .outputOptions([
        '-vf',
        `select='gt(scene,${threshold})',showinfo`,
        '-f',
        'null',
      ])
      .output('-')
      .on('stderr', (line: string) => {
        // showinfo emits lines containing pts_time:N.NNN
        const m = /pts_time:([\d.]+)/.exec(line)
        if (m?.[1]) {
          cutPoints.push({ timeSeconds: parseFloat(m[1]), score: 1.0 })
        }
      })
      .on('end', () => {
        resolve(cutPoints.sort((a, b) => a.timeSeconds - b.timeSeconds))
      })
      .on('error', (err: Error) => {
        // A non-zero exit with no output is normal when there are no scene changes
        if (cutPoints.length > 0) resolve(cutPoints.sort((a, b) => a.timeSeconds - b.timeSeconds))
        else if (err.message.includes('No such file')) reject(err)
        else resolve([]) // treat as "no cuts found"
      })
      .run()
  })
}

// ── trimVideo ─────────────────────────────────────────────────────────────────

/**
 * Trims a video to [startSec, endSec]. Uses stream copy for speed.
 */
export function trimVideo(
  inputPath: string,
  startSec: number,
  endSec: number,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    Ffmpeg(inputPath)
      .setStartTime(startSec)
      .setDuration(endSec - startSec)
      .outputOptions(['-c', 'copy', '-avoid_negative_ts', 'make_zero'])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(new Error(`trimVideo failed: ${err.message}`)))
      .run()
  })
}

// ── applyColorGrade ────────────────────────────────────────────────────────────

const COLOR_GRADE_FILTERS: Record<ColorGradePreset, string> = {
  natural: 'eq=brightness=0.02:saturation=1.05:contrast=1.02',
  vivid: 'eq=brightness=0.02:saturation=1.4:contrast=1.1,unsharp=5:5:0.8:3:3:0',
  cinematic:
    "eq=brightness=-0.02:saturation=0.85:contrast=1.15,curves=r='0/0 0.5/0.45 1/0.9':b='0/0.05 0.5/0.55 1/1'",
  warm: 'eq=brightness=0.03:saturation=1.2:contrast=1.05,colorbalance=rs=0.1:gs=-0.05:bs=-0.1',
  cool: 'eq=brightness=0:saturation=1.1:contrast=1.05,colorbalance=rs=-0.1:gs=0:bs=0.15',
}

/**
 * Applies a color grade preset to a video using ffmpeg filters.
 * Audio is copied untouched.
 */
export function applyColorGrade(
  inputPath: string,
  outputPath: string,
  preset: ColorGradePreset = 'natural',
): Promise<void> {
  return new Promise((resolve, reject) => {
    Ffmpeg(inputPath)
      .videoFilters(COLOR_GRADE_FILTERS[preset])
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '22',
        '-c:a', 'copy',
        '-pix_fmt', 'yuv420p',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(new Error(`applyColorGrade failed: ${err.message}`)))
      .run()
  })
}

// ── extractSpeechTranscript ────────────────────────────────────────────────────

async function extractAudio(videoPath: string, audioOutputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    Ffmpeg(videoPath)
      .outputOptions(['-vn', '-c:a', 'libmp3lame', '-q:a', '3'])
      .output(audioOutputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(new Error(`audio extract failed: ${err.message}`)))
      .run()
  })
}

async function transcribeAssemblyAI(audioPath: string): Promise<Transcript> {
  const apiKey = process.env['ASSEMBLYAI_API_KEY']
  if (!apiKey) throw new Error('ASSEMBLYAI_API_KEY not set')

  // 1. Upload
  const buf = await fs.readFile(audioPath)
  const upRes = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/octet-stream' },
    body: buf,
  })
  if (!upRes.ok) throw new Error(`AssemblyAI upload failed: ${upRes.statusText}`)
  const { upload_url } = (await upRes.json()) as { upload_url: string }

  // 2. Request transcript
  const txRes = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: upload_url, speaker_labels: false }),
  })
  if (!txRes.ok) throw new Error(`AssemblyAI transcript request failed: ${txRes.statusText}`)
  const { id: txId } = (await txRes.json()) as { id: string }

  // 3. Poll
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000))
    const sRes = await fetch(`https://api.assemblyai.com/v2/transcript/${txId}`, {
      headers: { authorization: apiKey },
    })
    if (!sRes.ok) continue

    const data = (await sRes.json()) as {
      status: string
      text?: string
      words?: Array<{ text: string; start: number; end: number; confidence: number }>
      error?: string
    }

    if (data.status === 'completed') {
      return {
        text: data.text ?? '',
        ...(data.words
          ? {
              words: data.words.map((w) => ({
                text: w.text,
                start: w.start / 1000,
                end: w.end / 1000,
                confidence: w.confidence,
              })),
            }
          : {}),
        provider: 'assemblyai' as const,
      }
    }
    if (data.status === 'error') {
      throw new Error(`AssemblyAI error: ${data.error ?? 'unknown'}`)
    }
  }
  throw new Error('AssemblyAI transcription timed out')
}

async function transcribeWhisper(audioPath: string): Promise<Transcript> {
  const outDir = tmpdir()
  const baseName = audioPath.split('/').pop()?.replace(/\.\w+$/, '') ?? 'audio'

  // Try whisper CLI first, then python -m whisper
  for (const args of [
    ['whisper', [audioPath, '--model', 'tiny', '--output_format', 'txt', '--output_dir', outDir]],
    [
      'python3',
      ['-m', 'whisper', audioPath, '--model', 'tiny', '--output_format', 'txt', '--output_dir', outDir],
    ],
  ] as [string, string[]][]) {
    try {
      await execFileAsync(args[0], args[1])
      const txtPath = join(outDir, `${baseName}.txt`)
      const text = await fs.readFile(txtPath, 'utf8').catch(() => '')
      return { text: text.trim(), provider: 'whisper' }
    } catch {
      // try next variant
    }
  }
  throw new Error('Whisper transcription unavailable (whisper CLI not found)')
}

/**
 * Extracts speech transcript from a video.
 * Tries AssemblyAI first (requires ASSEMBLYAI_API_KEY), falls back to local Whisper CLI.
 * Returns null if both fail.
 */
export async function extractSpeechTranscript(
  videoPath: string,
  opts: { log?: (msg: string) => void } = {},
): Promise<Transcript | null> {
  const log = opts.log ?? ((_: string) => undefined)
  const tmpAudio = join(tmpdir(), `fantom-tx-${Date.now()}.mp3`)

  try {
    await extractAudio(videoPath, tmpAudio)

    if (process.env['ASSEMBLYAI_API_KEY']) {
      try {
        log('Transcribing with AssemblyAI...')
        const result = await transcribeAssemblyAI(tmpAudio)
        log(`Transcript ready (${result.text.length} chars)`)
        return result
      } catch (err) {
        log(`AssemblyAI failed: ${String(err)} — falling back to Whisper`)
      }
    }

    try {
      log('Transcribing with Whisper (fallback)...')
      return await transcribeWhisper(tmpAudio)
    } catch (err) {
      log(`Whisper fallback failed: ${String(err)}`)
      return null
    }
  } finally {
    await fs.unlink(tmpAudio).catch(() => undefined)
  }
}

// ── smartCrop ─────────────────────────────────────────────────────────────────

/**
 * Scales and center-crops a video to exact target dimensions.
 * Fills the frame without letterboxing (may clip edges).
 */
export function smartCrop(
  inputPath: string,
  outputPath: string,
  targetWidth: number,
  targetHeight: number,
): Promise<void> {
  const filter =
    `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,` +
    `crop=${targetWidth}:${targetHeight}`

  return new Promise((resolve, reject) => {
    Ffmpeg(inputPath)
      .videoFilters(filter)
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '22',
        '-c:a', 'copy',
        '-pix_fmt', 'yuv420p',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(new Error(`smartCrop failed: ${err.message}`)))
      .run()
  })
}
