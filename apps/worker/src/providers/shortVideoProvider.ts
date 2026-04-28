import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildKey, putObjectFromFile, getObjectToFile } from '@fantom/storage'
import { synthesize } from '@fantom/voice'
import { fetchMusic } from '@fantom/music'
import type { MusicVibe } from '@fantom/music'
import Ffmpeg from 'fluent-ffmpeg'
import { CancelledError } from '@fantom/render-bus'
import type { RenderProvider, RenderContext, RenderResult } from '@fantom/render-bus'
import type { JobKind } from '@fantom/db'
import {
  getShortsJobRow,
  getBrandKitRow,
  getVoiceCloneRow,
  getAssetRow,
} from '../lib/db.js'

// ffmpeg-static is CJS; use createRequire so NodeNext module resolution finds it
const _require = createRequire(import.meta.url)
const ffmpegBinary = _require('ffmpeg-static') as string | null
if (ffmpegBinary) Ffmpeg.setFfmpegPath(ffmpegBinary)

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_DURATION_SECONDS = 120
const CROSSFADE_DURATION = 0.5
const OUTPUT_WIDTH = 1080
const OUTPUT_HEIGHT = 1920

// ── Helpers ───────────────────────────────────────────────────────────────────

function probeAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    Ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`ffprobe failed: ${err.message}`))
        return
      }
      resolve(metadata.format?.duration ?? 0)
    })
  })
}

async function findFontPath(): Promise<string | null> {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
    '/System/Library/Fonts/Helvetica.ttc', // macOS (dev only)
  ]
  for (const p of candidates) {
    try {
      await fs.access(p)
      return p
    } catch {
      // try next
    }
  }
  return null
}

function escapeFfmpegText(text: string): string {
  return text
    .replace(/\\/g, '\\\\') // backslash first
    .replace(/'/g, '\u2019') // replace apostrophe with right single quotation mark
    .replace(/:/g, '\\:') // colon is a field separator in ffmpeg filters
    .replace(/[\n\r]+/g, ' ') // newlines → spaces
    .trim()
}

const IMAGE_EXT_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

function getImageExt(mimeType: string): string {
  return IMAGE_EXT_MAP[mimeType] ?? 'jpg'
}

const VALID_MUSIC_VIBES = new Set<string>(['upbeat', 'calm', 'dramatic', 'inspirational', 'none'])

function toMusicVibe(v: string | null | undefined): MusicVibe {
  if (typeof v === 'string' && VALID_MUSIC_VIBES.has(v)) return v as MusicVibe
  return 'calm'
}

// ── Filter complex builder ────────────────────────────────────────────────────

interface FilterComplexParams {
  photoCount: number
  voiceInputIdx: number
  musicInputIdx: number | null
  logoInputIdx: number | null
  voiceDuration: number
  captionText: string | null
  fontPath: string | null
}

interface FilterComplexResult {
  filterStr: string
  videoLabel: string
  audioLabel: string
}

function buildFilterComplex(params: FilterComplexParams): FilterComplexResult {
  const {
    photoCount: N,
    voiceInputIdx,
    musicInputIdx,
    logoInputIdx,
    voiceDuration: D,
    captionText,
    fontPath,
  } = params

  const c = CROSSFADE_DURATION
  // segDur: each photo segment duration so N segments with N-1 crossfades = D total
  const segDur = N > 1 ? (D + c * (N - 1)) / N : D

  const parts: string[] = []

  // ── Scale each photo to 9:16 ──────────────────────────────────────────────
  for (let i = 0; i < N; i++) {
    parts.push(
      `[${i}:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,` +
        `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1,fps=30,setpts=PTS-STARTPTS[v${i}]`,
    )
  }

  // ── Xfade chain ───────────────────────────────────────────────────────────
  let currentLabel: string
  if (N === 1) {
    currentLabel = 'v0'
  } else {
    for (let i = 0; i < N - 1; i++) {
      const inA = i === 0 ? 'v0' : `xf${i - 1}`
      const inB = `v${i + 1}`
      // offset_i = (i+1) * (segDur - c): cumulative crossfade offset
      const offset = ((i + 1) * (segDur - c)).toFixed(3)
      const outLabel = i === N - 2 ? 'video_raw' : `xf${i}`
      parts.push(
        `[${inA}][${inB}]xfade=transition=fade:duration=${c}:offset=${offset}[${outLabel}]`,
      )
    }
    currentLabel = 'video_raw'
  }

  // ── Caption ───────────────────────────────────────────────────────────────
  if (captionText) {
    const escaped = escapeFfmpegText(captionText)
    const fontfileParam = fontPath ? `fontfile='${fontPath}':` : ''
    const nextLabel = 'captioned'
    parts.push(
      `[${currentLabel}]drawtext=${fontfileParam}text='${escaped}':` +
        `fontsize=52:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12:` +
        `x=(w-text_w)/2:y=h*0.85[${nextLabel}]`,
    )
    currentLabel = nextLabel
  }

  // ── Logo watermark ────────────────────────────────────────────────────────
  if (logoInputIdx !== null) {
    const nextLabel = 'watermarked'
    parts.push(
      `[${currentLabel}][${logoInputIdx}:v]scale=120:120,overlay=x=W-w-24:y=24[${nextLabel}]`,
    )
    currentLabel = nextLabel
  }

  // ── Audio mix ─────────────────────────────────────────────────────────────
  const audioLabel = 'audio_final'
  const dStr = D.toFixed(3)

  if (musicInputIdx !== null) {
    parts.push(`[${voiceInputIdx}:a]atrim=0:${dStr},asetpts=PTS-STARTPTS[voice]`)
    parts.push(
      `[${musicInputIdx}:a]volume=0.126,aloop=loop=-1:size=2147483647,` +
        `atrim=0:${dStr},asetpts=PTS-STARTPTS[music]`,
    )
    parts.push(`[voice][music]amix=inputs=2:normalize=0[${audioLabel}]`)
  } else {
    parts.push(`[${voiceInputIdx}:a]atrim=0:${dStr},asetpts=PTS-STARTPTS[${audioLabel}]`)
  }

  return { filterStr: parts.join(';'), videoLabel: currentLabel, audioLabel }
}

// ── ffmpeg runner ─────────────────────────────────────────────────────────────

interface RunShortFfmpegParams {
  photos: string[]
  voiceAudio: string
  musicAudio: string | null
  logoImage: string | null
  segDur: number
  filterStr: string
  videoLabel: string
  audioLabel: string
  output: string
  onProgress: (pct: number) => void
  checkCancelled: () => Promise<void>
}

function runShortFfmpeg(params: RunShortFfmpegParams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const {
      photos,
      voiceAudio,
      musicAudio,
      logoImage,
      segDur,
      filterStr,
      videoLabel,
      audioLabel,
      output,
    } = params

    let durationSeconds: number | null = null
    let lastTimemark = '00:00:00.00'
    let killed = false

    // Use ceil + 1s buffer so photo loop has enough frames for all xfades
    const photoInputDur = Math.ceil(segDur + CROSSFADE_DURATION + 1)

    let cmd = Ffmpeg()

    // Photo inputs — each looped still image
    for (const photo of photos) {
      cmd = cmd.input(photo).inputOptions(['-loop', '1', '-t', String(photoInputDur)])
    }

    // Voice audio
    cmd = cmd.input(voiceAudio)

    // Music (optional)
    if (musicAudio) cmd = cmd.input(musicAudio)

    // Logo (optional)
    if (logoImage) cmd = cmd.input(logoImage).inputOptions(['-loop', '1'])

    cmd = cmd.outputOptions([
      '-filter_complex', filterStr,
      '-map', `[${videoLabel}]`,
      '-map', `[${audioLabel}]`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-shortest',
    ])

    cmd = cmd.output(output)

    const abortController = new AbortController()
    abortController.signal.addEventListener('abort', () => {
      killed = true
      cmd.kill('SIGTERM')
    }, { once: true })

    const pollInterval = setInterval(() => {
      void params.checkCancelled().catch((err) => {
        if (err instanceof CancelledError) abortController.abort()
      })
    }, 2000)

    cmd.on('progress', (progress) => {
      if (progress.timemark) lastTimemark = progress.timemark
      params.onProgress(progress.percent ?? 0)
    })

    cmd.on('end', () => {
      clearInterval(pollInterval)
      const parts = lastTimemark.split(':')
      if (parts.length === 3) {
        const [h, m, s] = parts
        durationSeconds =
          parseInt(h ?? '0', 10) * 3600 +
          parseInt(m ?? '0', 10) * 60 +
          parseFloat(s ?? '0')
      }
      resolve(durationSeconds)
    })

    cmd.on('error', (err) => {
      clearInterval(pollInterval)
      if (killed) reject(new CancelledError())
      else reject(new Error(`ffmpeg failed: ${err.message}`))
    })

    cmd.run()
  })
}

// ── ShortVideoProvider ────────────────────────────────────────────────────────

export class ShortVideoProvider implements RenderProvider {
  readonly name = 'short-video'

  canHandle(kind: JobKind): boolean {
    return kind === 'render_short_video'
  }

  async render(context: RenderContext): Promise<RenderResult> {
    const { jobId, tenantId, tenantSlug, input, onProgress, checkCancelled, log } = context

    const shortsJobId = typeof input['shortsJobId'] === 'string' ? input['shortsJobId'] : null
    if (!shortsJobId) throw new Error('ShortVideoProvider: input missing shortsJobId')

    const tempFiles: string[] = []

    try {
      // ── 1. Fetch shorts_job record ────────────────────────────────────────
      log('Loading shorts job...')
      const shortsJob = await getShortsJobRow(shortsJobId, tenantId)
      if (!shortsJob) throw new Error(`ShortsJob ${shortsJobId} not found`)

      const {
        inputAssetIds,
        voiceCloneId,
        brandKitId,
        script,
        captionText,
        musicVibe,
      } = shortsJob

      if (!inputAssetIds || inputAssetIds.length === 0) {
        throw new Error('Shorts job has no photos')
      }
      if (!script) throw new Error('Shorts job has no script')

      // ── 2. Resolve voice ID ───────────────────────────────────────────────
      let providerVoiceId: string | undefined
      if (voiceCloneId) {
        const clone = await getVoiceCloneRow(voiceCloneId, tenantId)
        if (clone?.providerVoiceId) providerVoiceId = clone.providerVoiceId
      }
      if (!providerVoiceId) {
        // API validates voiceCloneId is required, but guard here in case of
        // direct DB manipulation or migration edge cases.
        providerVoiceId = process.env['ELEVENLABS_DEFAULT_VOICE_ID']
        if (!providerVoiceId) {
          throw new Error(
            'No voice clone selected and ELEVENLABS_DEFAULT_VOICE_ID is not set. ' +
            'Select a voice clone when creating the short.',
          )
        }
      }

      // ── 3. Synthesize TTS ─────────────────────────────────────────────────
      log('Synthesizing voiceover...')
      const tmpAudio = join(tmpdir(), `fantom-short-${jobId}-voice.mp3`)
      tempFiles.push(tmpAudio)

      const audioBuffer = await synthesize({ text: script, voiceId: providerVoiceId })
      await fs.writeFile(tmpAudio, audioBuffer)

      onProgress(15)
      await checkCancelled()

      // ── 4. Probe audio duration ───────────────────────────────────────────
      const rawDuration = await probeAudioDuration(tmpAudio)
      const voiceDuration = Math.min(rawDuration, MAX_DURATION_SECONDS)
      log(`Voice duration: ${voiceDuration.toFixed(1)}s`)

      // ── 5. Download photos ────────────────────────────────────────────────
      log(`Downloading ${inputAssetIds.length} photos...`)
      const photoPaths: string[] = []

      for (let i = 0; i < inputAssetIds.length; i++) {
        const assetId = inputAssetIds[i]!
        const asset = await getAssetRow(assetId, tenantId)
        if (!asset) throw new Error(`Photo asset ${assetId} not found`)

        const ext = getImageExt(asset.mimeType)
        const tmpPath = join(tmpdir(), `fantom-short-${jobId}-photo-${i}.${ext}`)
        await getObjectToFile(asset.r2Key, tmpPath)
        photoPaths.push(tmpPath)
        tempFiles.push(tmpPath)
      }

      onProgress(30)
      await checkCancelled()

      // ── 6. Fetch background music ─────────────────────────────────────────
      log('Fetching background music...')
      const vibe = toMusicVibe(musicVibe)
      const musicResult = await fetchMusic(vibe, voiceDuration, log)
      let tmpMusic: string | null = null
      if (musicResult) {
        tmpMusic = musicResult.filePath
        tempFiles.push(tmpMusic)
      }

      await checkCancelled()

      // ── 7. Download logo (if brand kit has one) ───────────────────────────
      let tmpLogo: string | null = null
      if (brandKitId) {
        const brandKit = await getBrandKitRow(brandKitId, tenantId)
        if (brandKit?.logoAssetId) {
          try {
            const logoAsset = await getAssetRow(brandKit.logoAssetId, tenantId)
            if (logoAsset) {
              const ext = getImageExt(logoAsset.mimeType)
              tmpLogo = join(tmpdir(), `fantom-short-${jobId}-logo.${ext}`)
              await getObjectToFile(logoAsset.r2Key, tmpLogo)
              tempFiles.push(tmpLogo)
              log('Logo downloaded')
            }
          } catch (err) {
            log(`Logo download failed (skipping): ${String(err)}`)
          }
        }
      }

      onProgress(40)
      await checkCancelled()

      // ── 8. Find font path ─────────────────────────────────────────────────
      const fontPath = await findFontPath()
      if (!fontPath) log('No font file found — using ffmpeg default font')

      // ── 9. Build filter complex ───────────────────────────────────────────
      const N = photoPaths.length
      const c = CROSSFADE_DURATION
      const segDur = N > 1 ? (voiceDuration + c * (N - 1)) / N : voiceDuration
      // (N is photo count derived from inputAssetIds)

      const voiceInputIdx = N
      const musicInputIdx = tmpMusic !== null ? N + 1 : null
      const logoInputIdx =
        tmpLogo !== null ? (musicInputIdx !== null ? N + 2 : N + 1) : null

      const { filterStr, videoLabel, audioLabel } = buildFilterComplex({
        photoCount: N,
        voiceInputIdx,
        musicInputIdx,
        logoInputIdx,
        voiceDuration,
        captionText: captionText ?? null,
        fontPath,
      })

      // ── 10. Run ffmpeg ────────────────────────────────────────────────────
      const tmpOutput = join(tmpdir(), `fantom-short-${jobId}-output.mp4`)
      tempFiles.push(tmpOutput)

      log('Starting ffmpeg render...')
      const durationSeconds = await runShortFfmpeg({
        photos: photoPaths,
        voiceAudio: tmpAudio,
        musicAudio: tmpMusic,
        logoImage: tmpLogo,
        segDur,
        filterStr,
        videoLabel,
        audioLabel,
        output: tmpOutput,
        onProgress: (pct) => onProgress(Math.floor(40 + pct * 0.5)),
        checkCancelled,
      })

      onProgress(90)
      log(`Render complete, duration: ${durationSeconds?.toFixed(1) ?? '?'}s`)

      // ── 11. Upload to R2 ──────────────────────────────────────────────────
      const { size: videoSizeBytes } = await fs.stat(tmpOutput)
      const videoKey = buildKey(tenantSlug, 'video', `short-${jobId}.mp4`)

      await putObjectFromFile(videoKey, tmpOutput, 'video/mp4')
      log(`Uploaded: ${videoKey}`)

      return {
        r2Key: videoKey,
        mimeType: 'video/mp4',
        sizeBytes: videoSizeBytes,
        durationSeconds,
        width: OUTPUT_WIDTH,
        height: OUTPUT_HEIGHT,
        originalFilename: `short-${jobId}.mp4`,
      }
    } finally {
      for (const f of tempFiles) {
        await fs.unlink(f).catch(() => undefined)
      }
    }
  }
}
