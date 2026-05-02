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
import { generateSrtFile } from '../lib/srt.js'

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
  coBrandLogoInputIdx: number | null
  complianceLogoInputIdx: number | null
  voiceDuration: number
  /** Authoritative output length — may be longer than voiceDuration. */
  finalDuration: number
  /** Path to a pre-generated .srt file, or null if captions are disabled. */
  srtPath: string | null
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
    coBrandLogoInputIdx,
    complianceLogoInputIdx,
    voiceDuration,
    finalDuration,
    srtPath,
  } = params

  const c = CROSSFADE_DURATION
  // segDur based on finalDuration (authoritative), not voiceDuration.
  // Photos are looped stills, so they can extend as long as needed.
  const segDur = N > 1 ? (finalDuration + c * (N - 1)) / N : finalDuration

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

  // ── Caption (SRT-based via subtitles filter — no libfreetype required) ───────
  if (srtPath) {
    parts.push(
      `[${currentLabel}]subtitles='${srtPath}':` +
        `force_style='Fontsize=18,PrimaryColour=&Hffffff,OutlineColour=&H80000000,` +
        `BorderStyle=4,Outline=4,MarginV=40,Alignment=2'[captioned]`,
    )
    currentLabel = 'captioned'
  }

  // ── Logo watermarks ───────────────────────────────────────────────────────
  if (logoInputIdx !== null) {
    // Primary brand: fits within 300×150 bounding box, 90% opacity — top-left
    parts.push(
      `[${logoInputIdx}:v]scale=300:150:force_original_aspect_ratio=decrease,` +
        `format=rgba,colorchannelmixer=aa=0.9[logo_primary]`,
    )
    parts.push(`[${currentLabel}][logo_primary]overlay=x=32:y=32[wm1]`)
    currentLabel = 'wm1'
  }

  if (coBrandLogoInputIdx !== null) {
    // Co-brand (agent identity): fits within 720×360 bounding box, 90% opacity — bottom-left.
    // y=H-h-200: bottom edge sits 200px above the frame bottom.
    // At max h=360: logo top at 1920-360-200=1560, bottom at 1720. Caption zone ~1720-1880 → no collision.
    parts.push(
      `[${coBrandLogoInputIdx}:v]scale=720:360:force_original_aspect_ratio=decrease,` +
        `format=rgba,colorchannelmixer=aa=0.9[logo_cobrand]`,
    )
    parts.push(`[${currentLabel}][logo_cobrand]overlay=x=32:y=H-h-200[wm2]`)
    currentLabel = 'wm2'
  }

  if (complianceLogoInputIdx !== null) {
    // Compliance: max 60px tall, bottom-center, 16px from frame bottom
    parts.push(
      `[${complianceLogoInputIdx}:v]scale=180:60:force_original_aspect_ratio=decrease,` +
        `format=rgba,colorchannelmixer=aa=0.9[logo_compliance]`,
    )
    parts.push(`[${currentLabel}][logo_compliance]overlay=x=(W-w)/2:y=H-h-16[wm3]`)
    currentLabel = 'wm3'
  }

  // ── Audio mix ─────────────────────────────────────────────────────────────
  // Voice trims to its actual TTS length; music / silence fills to finalDuration.
  // This lets photos run their full segment duration even when voice ends early.
  const audioLabel = 'audio_final'
  const vStr = voiceDuration.toFixed(3)
  const fStr = finalDuration.toFixed(3)

  if (musicInputIdx !== null) {
    // Pad voice with silence to finalDuration so amix doesn't end early.
    parts.push(
      `[${voiceInputIdx}:a]atrim=0:${vStr},asetpts=PTS-STARTPTS,apad=whole_dur=${fStr}[voice]`,
    )
    parts.push(
      `[${musicInputIdx}:a]volume=0.126,aloop=loop=-1:size=2147483647,` +
        `atrim=0:${fStr},asetpts=PTS-STARTPTS[music]`,
    )
    parts.push(`[voice][music]amix=inputs=2:normalize=0:duration=longest[${audioLabel}]`)
  } else {
    // No music — pad silence after voice to reach finalDuration.
    parts.push(
      `[${voiceInputIdx}:a]atrim=0:${vStr},asetpts=PTS-STARTPTS,apad=whole_dur=${fStr}[${audioLabel}]`,
    )
  }

  return { filterStr: parts.join(';'), videoLabel: currentLabel, audioLabel }
}

// ── ffmpeg runner ─────────────────────────────────────────────────────────────

interface RunShortFfmpegParams {
  photos: string[]
  voiceAudio: string
  musicAudio: string | null
  logoImage: string | null
  coBrandLogoImage: string | null
  complianceLogoImage: string | null
  segDur: number
  /** Authoritative output length used for -t flag (replaces -shortest). */
  finalDuration: number
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
      coBrandLogoImage,
      complianceLogoImage,
      segDur,
      finalDuration,
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

    // Logos (optional)
    if (logoImage) cmd = cmd.input(logoImage).inputOptions(['-loop', '1'])
    if (coBrandLogoImage) cmd = cmd.input(coBrandLogoImage).inputOptions(['-loop', '1'])
    if (complianceLogoImage) cmd = cmd.input(complianceLogoImage).inputOptions(['-loop', '1'])

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
      // Explicit duration cap — replaces -shortest. Ensures output is exactly finalDuration.
      '-t', finalDuration.toFixed(3),
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
        coBrandKitId,
        complianceKitId,
        script,
        captionText,
        musicVibe,
        targetDurationSeconds,
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

      // ── 7. Download logos ─────────────────────────────────────────────────
      async function downloadKitLogo(kitId: string | null, suffix: string): Promise<string | null> {
        if (!kitId) return null
        try {
          const kit = await getBrandKitRow(kitId, tenantId)
          if (!kit?.logoAssetId) return null
          const logoAsset = await getAssetRow(kit.logoAssetId, tenantId)
          if (!logoAsset) return null
          const ext = getImageExt(logoAsset.mimeType)
          const path = join(tmpdir(), `fantom-short-${jobId}-logo-${suffix}.${ext}`)
          await getObjectToFile(logoAsset.r2Key, path)
          tempFiles.push(path)
          log(`Logo downloaded: ${suffix}`)
          return path
        } catch (err) {
          log(`Logo download failed for kit ${kitId} (skipping): ${String(err)}`)
          return null
        }
      }

      const [tmpLogo, tmpCoBrandLogo, tmpComplianceLogo] = await Promise.all([
        downloadKitLogo(brandKitId ?? null, 'primary'),
        downloadKitLogo(coBrandKitId ?? null, 'cobrand'),
        downloadKitLogo(complianceKitId ?? null, 'compliance'),
      ])

      onProgress(40)
      await checkCancelled()

      // ── 8. Generate SRT captions ──────────────────────────────────────────
      const srtPath = await generateSrtFile(captionText, jobId, voiceDuration)
      if (srtPath) {
        tempFiles.push(srtPath)
        log('SRT captions written')
      }

      // ── 9. Build filter complex ───────────────────────────────────────────
      const N = photoPaths.length
      const c = CROSSFADE_DURATION

      // targetDurationSeconds is authoritative. If TTS somehow ran long, extend rather than clip.
      const finalDuration = Math.max(targetDurationSeconds, voiceDuration)
      if (voiceDuration > targetDurationSeconds) {
        log(
          `[duration] voice (${voiceDuration.toFixed(1)}s) exceeds target (${targetDurationSeconds}s) ` +
            `— extending video to avoid cutting the audio`,
        )
      }
      const segDur = N > 1 ? (finalDuration + c * (N - 1)) / N : finalDuration
      log(
        `[duration] target=${targetDurationSeconds}s, photos=${N}, ` +
          `voice=${voiceDuration.toFixed(1)}s, final=${finalDuration.toFixed(1)}s, segDur=${segDur.toFixed(3)}s`,
      )

      const voiceInputIdx = N
      const musicInputIdx = tmpMusic !== null ? N + 1 : null
      let nextIdx = musicInputIdx !== null ? N + 2 : N + 1
      const logoInputIdx = tmpLogo !== null ? nextIdx++ : null
      const coBrandLogoInputIdx = tmpCoBrandLogo !== null ? nextIdx++ : null
      const complianceLogoInputIdx = tmpComplianceLogo !== null ? nextIdx++ : null

      const { filterStr, videoLabel, audioLabel } = buildFilterComplex({
        photoCount: N,
        voiceInputIdx,
        musicInputIdx,
        logoInputIdx,
        coBrandLogoInputIdx,
        complianceLogoInputIdx,
        voiceDuration,
        finalDuration,
        srtPath,
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
        coBrandLogoImage: tmpCoBrandLogo,
        complianceLogoImage: tmpComplianceLogo,
        segDur,
        finalDuration,
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
