import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { buildKey, putObjectFromFile, getObjectToFile } from '@fantom/storage'
import { synthesize } from '@fantom/voice'
import Ffmpeg from 'fluent-ffmpeg'
import { CancelledError } from '@fantom/render-bus'
import type { RenderProvider, RenderContext, RenderResult } from '@fantom/render-bus'
import type { JobKind } from '@fantom/db'
import { getAssetRow, getVoiceCloneRow, createAssetRecord } from '../lib/db.js'

// ffmpeg-static is CJS; use createRequire so NodeNext module resolution finds it
const _require = createRequire(import.meta.url)
const ffmpegBinary = _require('ffmpeg-static') as string | null
if (ffmpegBinary) Ffmpeg.setFfmpegPath(ffmpegBinary)

// ── Input type ────────────────────────────────────────────────────────────────

interface FfmpegRenderInput {
  voiceCloneId: string
  text: string
  imageAssetId: string
}

// ── ffmpeg helper ─────────────────────────────────────────────────────────────

function runFfmpeg(
  imagePath: string,
  audioPath: string,
  outputPath: string,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let durationSeconds: number | null = null
    let lastTimemark = '00:00:00.00'
    let killed = false

    const command = Ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop', '1'])
      .input(audioPath)
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'stillimage',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-pix_fmt', 'yuv420p',
        '-shortest',
        '-movflags', '+faststart',
      ])
      .videoFilter(
        'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
      )
      .fps(30)
      .output(outputPath)

    if (signal) {
      signal.addEventListener('abort', () => {
        killed = true
        command.kill('SIGTERM')
      }, { once: true })
    }

    command.on('progress', (progress) => {
      if (progress.timemark) lastTimemark = progress.timemark
      onProgress(progress.percent ?? 0)
    })

    command.on('end', () => {
      const parts = lastTimemark.split(':')
      if (parts.length === 3) {
        const [h, m, s] = parts
        durationSeconds =
          parseInt(h ?? '0') * 3600 +
          parseInt(m ?? '0') * 60 +
          parseFloat(s ?? '0')
      }
      resolve(durationSeconds)
    })

    command.on('error', (err) => {
      if (killed) {
        reject(new CancelledError())
      } else {
        reject(new Error(`ffmpeg failed: ${err.message}`))
      }
    })

    command.run()
  })
}

// ── Memory logger ─────────────────────────────────────────────────────────────

function logMem(label: string): void {
  const m = process.memoryUsage()
  console.log(
    `[mem:${label}] rss=${Math.round(m.rss / 1024 / 1024)}MB` +
    ` heap=${Math.round(m.heapUsed / 1024 / 1024)}/${Math.round(m.heapTotal / 1024 / 1024)}MB`,
  )
}

// ── Step wrapper ──────────────────────────────────────────────────────────────

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`[${label}] ${msg}`)
  }
}

// ── FfmpegProvider ────────────────────────────────────────────────────────────

export class FfmpegProvider implements RenderProvider {
  readonly name = 'ffmpeg'

  canHandle(kind: JobKind): boolean {
    return kind === 'render_test_video'
  }

  async render(context: RenderContext): Promise<RenderResult> {
    const { jobId, tenantId, tenantSlug, input, onProgress, checkCancelled, log } = context

    const tmpImage = `/tmp/fantom-job-${jobId}-image`
    const tmpAudio = `/tmp/fantom-job-${jobId}-audio.mp3`
    const tmpOutput = `/tmp/fantom-job-${jobId}-output.mp4`

    try {
      const typedInput = input as unknown as FfmpegRenderInput
      if (!typedInput.voiceCloneId || !typedInput.text || !typedInput.imageAssetId) {
        throw new Error('Invalid job input: voiceCloneId, text, and imageAssetId are required')
      }

      // ── Fetch voice clone + image asset ──────────────────────────────────────

      const voiceClone = await getVoiceCloneRow(typedInput.voiceCloneId, tenantId)
      if (!voiceClone) throw new Error(`Voice clone ${typedInput.voiceCloneId} not found`)
      if (!voiceClone.providerVoiceId) throw new Error('Voice clone has no provider voice ID')
      const providerVoiceId = voiceClone.providerVoiceId

      const imageAsset = await getAssetRow(typedInput.imageAssetId, tenantId)
      if (!imageAsset) throw new Error(`Image asset ${typedInput.imageAssetId} not found`)

      logMem('start')
      onProgress(10)

      // ── Synthesize audio → write to disk ─────────────────────────────────────

      logMem('before-synthesize')
      const audioSizeBytes = await step('elevenlabs-synthesize', async () => {
        const buf = await synthesize({ text: typedInput.text, voiceId: providerVoiceId })
        await fs.writeFile(tmpAudio, buf)
        return buf.byteLength
      })
      logMem('after-synthesize')
      await checkCancelled()

      // ── Stream audio from disk to R2 ─────────────────────────────────────────

      const audioKey = buildKey(tenantSlug, 'audio', `job-${jobId}-audio.mp3`)
      await step('r2-put-audio', () => putObjectFromFile(audioKey, tmpAudio, 'audio/mpeg'))

      const audioAsset = await createAssetRecord({
        tenantId,
        kind: 'audio',
        r2Key: audioKey,
        originalFilename: `job-${jobId}-audio.mp3`,
        mimeType: 'audio/mpeg',
        sizeBytes: audioSizeBytes,
      })
      log(`audio asset created ${audioAsset.id}`)

      onProgress(30)
      await checkCancelled()

      // ── Stream image from R2 to disk ──────────────────────────────────────────

      const extMap: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
      }
      const imageExt = extMap[imageAsset.mimeType] ?? 'jpg'
      const tmpImageWithExt = `${tmpImage}.${imageExt}`

      logMem('before-r2-get-image')
      await step('r2-get-image', () => getObjectToFile(imageAsset.r2Key, tmpImageWithExt))
      logMem('after-r2-get-image')

      onProgress(40)
      await checkCancelled()

      // ── Run ffmpeg ─────────────────────────────────────────────────────────────

      logMem('before-ffmpeg')

      const ffmpegAbort = new AbortController()
      const ffmpegPollInterval = setInterval(() => {
        void checkCancelled().catch((err) => {
          if (err instanceof CancelledError) ffmpegAbort.abort()
        })
      }, 2000)

      let durationSeconds: number | null
      try {
        durationSeconds = await runFfmpeg(
          tmpImageWithExt,
          tmpAudio,
          tmpOutput,
          (pct) => {
            onProgress(Math.min(Math.floor(40 + pct * 0.5), 90))
          },
          ffmpegAbort.signal,
        )
      } finally {
        clearInterval(ffmpegPollInterval)
      }

      logMem('after-ffmpeg')

      onProgress(90)

      // ── Stream MP4 from disk to R2 ────────────────────────────────────────────

      const { size: videoSizeBytes } = await fs.stat(tmpOutput)
      const videoKey = buildKey(tenantSlug, 'video', `job-${jobId}-render.mp4`)

      logMem('before-r2-put-video')
      await step('r2-put-video', () => putObjectFromFile(videoKey, tmpOutput, 'video/mp4'))
      logMem('after-r2-put-video')

      return {
        r2Key: videoKey,
        mimeType: 'video/mp4',
        sizeBytes: videoSizeBytes,
        durationSeconds,
        width: 1920,
        height: 1080,
        originalFilename: `job-${jobId}-render.mp4`,
      }
    } finally {
      // Cleanup temp files — errors ignored (files may not have been created)
      const tmpFiles = [
        `${tmpImage}.jpg`,
        `${tmpImage}.png`,
        `${tmpImage}.webp`,
        `${tmpImage}.gif`,
        tmpAudio,
        tmpOutput,
      ]
      for (const f of tmpFiles) {
        await fs.unlink(f).catch(() => undefined)
      }
    }
  }
}
