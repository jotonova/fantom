import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildKey, putObjectFromFile, getObjectToFile, generateDownloadUrl } from '@fantom/storage'
import { synthesize } from '@fantom/voice'
import { fetchMusic } from '@fantom/music'
import type { MusicVibe } from '@fantom/music'
import { generateMotionClip, waitForCompletion, BudgetExceededError } from '@fantom/runway'
import type { RunwayTaskStatus } from '@fantom/runway'
import { applyColorGrade, smartCrop, extractSpeechTranscript } from '@fantom/video-editor'
import Ffmpeg from 'fluent-ffmpeg'
import { CancelledError } from '@fantom/render-bus'
import type { RenderProvider, RenderContext, RenderResult } from '@fantom/render-bus'
import type { JobKind } from '@fantom/db'
import {
  getShortsJobRow,
  getBrandKitRow,
  getVoiceCloneRow,
  getAssetRow,
  patchShortsJob,
  checkRunwayBudget,
  recordRunwayUsage,
} from '../lib/db.js'

const _require = createRequire(import.meta.url)
const ffmpegBinary = _require('ffmpeg-static') as string | null
if (ffmpegBinary) Ffmpeg.setFfmpegPath(ffmpegBinary)

// ── Filter availability probe (cached at startup) ─────────────────────────────

import { execFile } from 'node:child_process'

/** Returns true if the installed ffmpeg binary supports the named filter. */
function probeFilter(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const bin = ffmpegBinary ?? 'ffmpeg'
    execFile(bin, ['-filters'], { timeout: 5000 }, (_err, stdout) => {
      // Each line looks like "... xfade  VV->V  ..."
      resolve(stdout.includes(` ${name} `) || stdout.includes(`\t${name} `))
    })
  })
}

// Resolved once at first render; safe because ffmpeg-static is immutable per deploy.
let _drawTextAvailable: boolean | null = null
async function isDrawTextAvailable(): Promise<boolean> {
  if (_drawTextAvailable === null) _drawTextAvailable = await probeFilter('drawtext')
  return _drawTextAvailable
}

// ── Constants ─────────────────────────────────────────────────────────────────

const OUTPUT_WIDTH = 1080
const OUTPUT_HEIGHT = 1920
const CROSSFADE_S = 0.3
const MAX_VOICE_DURATION_S = 120
const RUNWAY_CLIP_DURATION_S = 5 // Gen-3 Turbo always produces 5s clips
const ASSET_BATCH_SIZE = 4

// ── Helpers ───────────────────────────────────────────────────────────────────

function probeVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    Ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) reject(new Error(`ffprobe failed: ${err.message}`))
      else resolve(meta.format?.duration ?? 0)
    })
  })
}

async function findFontPath(): Promise<string | null> {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
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
    .replace(/[^\x00-\x7F]/g, '')  // strip non-ASCII (emoji etc — drawtext font won't have glyphs)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\u2019')
    .replace(/:/g, '\\:')
    .replace(/[\n\r]+/g, ' ')
    .trim()
}

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

const VIDEO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
}

function getExt(mimeType: string): string {
  return IMAGE_EXT[mimeType] ?? VIDEO_EXT[mimeType] ?? 'bin'
}

const VALID_MUSIC_VIBES = new Set<string>(['upbeat', 'calm', 'dramatic', 'inspirational', 'none'])
function toMusicVibe(v: string | null | undefined): MusicVibe {
  if (typeof v === 'string' && VALID_MUSIC_VIBES.has(v)) return v as MusicVibe
  return 'calm'
}

/** Convert a local file to a base64 data URL for Runway. */
async function toBase64DataUrl(filePath: string, mimeType: string): Promise<string> {
  const buf = await fs.readFile(filePath)
  return `data:${mimeType};base64,${buf.toString('base64')}`
}

/** Fetch a URL and save to a file. */
async function downloadUrl(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`)
  const buf = await res.arrayBuffer()
  await fs.writeFile(dest, Buffer.from(buf))
}

/** Process N items in parallel batches of batchSize. */
async function batchProcess<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map((item, j) => fn(item, i + j)))
    results.push(...batchResults)
  }
  return results
}

// ── ffmpeg compose ─────────────────────────────────────────────────────────────

interface ComposeParams {
  clipPaths: string[]
  voiceAudio: string
  voiceDuration: number
  musicAudio: string | null
  /** Null, or null if drawtext unavailable in current ffmpeg build. */
  captionText: string | null
  fontPath: string | null
  logoPath: string | null
  coBrandLogoPath: string | null
  complianceLogoPath: string | null
  output: string
  onProgress: (pct: number) => void
  checkCancelled: () => Promise<void>
}

function buildComposeCommand(params: ComposeParams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const {
      clipPaths,
      voiceAudio,
      voiceDuration: D,
      musicAudio,
      captionText,
      fontPath,
      logoPath,
      coBrandLogoPath,
      complianceLogoPath,
      output,
    } = params

    // Expand clip list to cover voice duration by looping
    let clips = [...clipPaths]
    const naturalDuration = clips.length * RUNWAY_CLIP_DURATION_S
    if (naturalDuration < D) {
      const repeats = Math.ceil(D / naturalDuration)
      for (let r = 1; r < repeats; r++) clips = [...clips, ...clipPaths]
    }

    const M = clips.length
    const C = CROSSFADE_S
    const segDur = M > 1 ? (D + C * (M - 1)) / M : D

    const filterParts: string[] = []

    // Phase 1: Scale/trim each clip to segDur, ensure 9:16 1080×1920
    for (let i = 0; i < M; i++) {
      filterParts.push(
        `[${i}:v]trim=duration=${segDur.toFixed(3)},setpts=PTS-STARTPTS,` +
          `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,` +
          `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1,fps=30[v${i}]`,
      )
    }

    // Phase 2: xfade chain
    let currentVideo: string
    if (M === 1) {
      currentVideo = 'v0'
    } else {
      for (let i = 0; i < M - 1; i++) {
        const inA = i === 0 ? 'v0' : `xf${i - 1}`
        const inB = `v${i + 1}`
        const offset = ((i + 1) * (segDur - C)).toFixed(3)
        const outLabel = i === M - 2 ? 'video_xfade' : `xf${i}`
        filterParts.push(
          `[${inA}][${inB}]xfade=transition=fade:duration=${C}:offset=${offset}[${outLabel}]`,
        )
      }
      currentVideo = 'video_xfade'
    }

    // Phase 3: Captions
    if (captionText) {
      const esc = escapeFfmpegText(captionText)
      const fontfileParam = fontPath ? `fontfile='${fontPath}':` : ''
      filterParts.push(
        `[${currentVideo}]drawtext=${fontfileParam}text='${esc}':` +
          `fontsize=52:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12:` +
          `x=(w-text_w)/2:y=h*0.85[captioned]`,
      )
      currentVideo = 'captioned'
    }

    // Phase 4: Watermarks (primary logo, co-brand logo, compliance logo)
    // Input indices: clips 0..M-1, voice at M, music at M+1 (if any), then logos
    const voiceIdx = M
    const musicIdx = musicAudio !== null ? M + 1 : null
    let nextInputIdx = musicIdx !== null ? M + 2 : M + 1

    if (logoPath !== null) {
      const idx = nextInputIdx++
      filterParts.push(
        `[${currentVideo}][${idx}:v]scale=120:120,overlay=x=W-w-24:y=24[wm1]`,
      )
      currentVideo = 'wm1'
    }

    if (coBrandLogoPath !== null) {
      const idx = nextInputIdx++
      filterParts.push(
        `[${currentVideo}][${idx}:v]scale=100:100,overlay=x=24:y=24[wm2]`,
      )
      currentVideo = 'wm2'
    }

    if (complianceLogoPath !== null) {
      const idx = nextInputIdx++
      filterParts.push(
        `[${currentVideo}][${idx}:v]scale=80:80,overlay=x=(W-w)/2:y=H-h-24[wm3]`,
      )
      currentVideo = 'wm3'
    }

    // Phase 5: Audio — voice + ducked music
    const dStr = D.toFixed(3)
    if (musicIdx !== null) {
      filterParts.push(`[${voiceIdx}:a]atrim=0:${dStr},asetpts=PTS-STARTPTS[voice]`)
      filterParts.push(
        `[${musicIdx}:a]volume=0.126,aloop=loop=-1:size=2147483647,` +
          `atrim=0:${dStr},asetpts=PTS-STARTPTS[music]`,
      )
      filterParts.push(`[voice][music]amix=inputs=2:normalize=0[audio_final]`)
    } else {
      filterParts.push(`[${voiceIdx}:a]atrim=0:${dStr},asetpts=PTS-STARTPTS[audio_final]`)
    }

    // Build ffmpeg command
    const photoInputDur = Math.ceil(segDur + CROSSFADE_S + 1)
    let cmd = Ffmpeg()

    for (const clipPath of clips) {
      cmd = cmd.input(clipPath).inputOptions(['-t', String(photoInputDur)])
    }
    cmd = cmd.input(voiceAudio)
    if (musicAudio) cmd = cmd.input(musicAudio)
    if (logoPath) cmd = cmd.input(logoPath).inputOptions(['-loop', '1'])
    if (coBrandLogoPath) cmd = cmd.input(coBrandLogoPath).inputOptions(['-loop', '1'])
    if (complianceLogoPath) cmd = cmd.input(complianceLogoPath).inputOptions(['-loop', '1'])

    // complexFilter() passes the graph as a single spawn argument, avoiding
    // fluent-ffmpeg's whitespace-splitting of outputOptions array elements.
    cmd = cmd.complexFilter(filterParts.join(';'))
    cmd = cmd.outputOptions([
      '-map', `[${currentVideo}]`,
      '-map', '[audio_final]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-b:v', '6000k',
      '-maxrate', '8000k',
      '-bufsize', '16000k',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-shortest',
    ])

    cmd = cmd.output(output)

    let durationSeconds: number | null = null
    let lastTimemark = '00:00:00.00'
    let killed = false

    const abortController = new AbortController()
    abortController.signal.addEventListener(
      'abort',
      () => {
        killed = true
        cmd.kill('SIGTERM')
      },
      { once: true },
    )

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
      else reject(new Error(`ffmpeg compose failed: ${err.message}`))
    })

    cmd.run()
  })
}

// ── MultiModalRenderProvider ──────────────────────────────────────────────────

export class MultiModalRenderProvider implements RenderProvider {
  readonly name = 'multi-modal'

  canHandle(kind: JobKind): boolean {
    return kind === 'render_short_video'
  }

  async render(context: RenderContext): Promise<RenderResult> {
    const { jobId, tenantId, tenantSlug, input, onProgress, checkCancelled, log } = context

    const shortsJobId = typeof input['shortsJobId'] === 'string' ? input['shortsJobId'] : null
    if (!shortsJobId) throw new Error('MultiModalRenderProvider: input missing shortsJobId')

    const tempFiles: string[] = []

    try {
      // ── 1. Load shorts_job ────────────────────────────────────────────────
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
        motionHints,
      } = shortsJob

      if (!inputAssetIds || inputAssetIds.length === 0) {
        throw new Error('Shorts job has no input assets')
      }
      if (!script) throw new Error('Shorts job has no script')

      // ── 2. Resolve voice ──────────────────────────────────────────────────
      let providerVoiceId: string | undefined
      if (voiceCloneId) {
        const clone = await getVoiceCloneRow(voiceCloneId, tenantId)
        if (clone?.providerVoiceId) providerVoiceId = clone.providerVoiceId
      }
      if (!providerVoiceId) {
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
      const tmpAudio = join(tmpdir(), `fantom-mm-${jobId}-voice.mp3`)
      tempFiles.push(tmpAudio)
      const audioBuffer = await synthesize({ text: script, voiceId: providerVoiceId })
      await fs.writeFile(tmpAudio, audioBuffer)

      const rawDuration = await probeVideoDuration(tmpAudio)
      const voiceDuration = Math.min(rawDuration, MAX_VOICE_DURATION_S)
      log(`Voice duration: ${voiceDuration.toFixed(1)}s`)

      onProgress(10)
      await checkCancelled()

      // ── 4. Process input assets in parallel batches of 4 ─────────────────
      log(`Processing ${inputAssetIds.length} input assets...`)

      // Initialize per-asset status
      const initStatus: Record<string, { status: string; taskId?: string }> = {}
      for (const id of inputAssetIds) {
        initStatus[id] = { status: 'pending' }
      }
      await patchShortsJob(shortsJobId, tenantId, {
        assetRenderStatus: initStatus,
      }).catch(console.error)

      const clipPaths: string[] = []

      await batchProcess(inputAssetIds, ASSET_BATCH_SIZE, async (assetId, index) => {
        const asset = await getAssetRow(assetId, tenantId)
        if (!asset) throw new Error(`Asset ${assetId} not found`)

        const ext = getExt(asset.mimeType)
        const isImage = asset.kind === 'image'
        // tmpSrc only needed for video assets (color grade + smart crop)
        const tmpSrc = isImage ? null : join(tmpdir(), `fantom-mm-${jobId}-src-${index}.${ext}`)
        const tmpClip = join(tmpdir(), `fantom-mm-${jobId}-clip-${index}.mp4`)
        if (tmpSrc) tempFiles.push(tmpSrc)
        tempFiles.push(tmpClip)

        // Mark asset as processing
        await patchShortsJob(shortsJobId, tenantId, {
          assetRenderStatus: { ...initStatus, [assetId]: { status: 'processing' } },
        }).catch(console.error)

        await checkCancelled()

        if (isImage) {
          // Image path: Runway Gen-3 Turbo → motion clip
          const budget = await checkRunwayBudget(tenantId)
          if (!budget.available) {
            throw new BudgetExceededError(budget.spentUsd, budget.capUsd)
          }

          // Generate a 30-min presigned GET URL for the R2 object.
          // base64 data URLs exceed Runway's 5MB limit for high-res photos;
          // the R2 public domain is not reliably accessible externally.
          const promptImage = await generateDownloadUrl(asset.r2Key)
          const hint = motionHints?.[assetId]

          log(`[asset ${index + 1}] Submitting to Runway Gen-3 Turbo (presigned url)`)

          const taskId = await generateMotionClip({
            promptImage,
            ...(hint ? { promptText: hint } : {}),
          })

          // Update status with task ID
          await patchShortsJob(shortsJobId, tenantId, {
            assetRenderStatus: { ...initStatus, [assetId]: { status: 'processing', taskId } },
          }).catch(console.error)

          log(`[asset ${index + 1}] Runway task ${taskId} — waiting for completion...`)
          const clip = await waitForCompletion(taskId, {
            onPoll: (status: RunwayTaskStatus) => {
              log(`[asset ${index + 1}] Runway task ${taskId}: ${status.status}`)
            },
          })

          // Download the rendered clip
          await downloadUrl(clip.outputUrl, tmpClip)

          // Record usage — non-skippable
          await recordRunwayUsage({
            tenantId,
            shortsJobId,
            assetId,
            taskId,
            creditsUsed: clip.creditsUsed,
            costUsd: clip.costUsd,
          })

          log(
            `[asset ${index + 1}] Runway clip ready (${clip.creditsUsed} credits / $${clip.costUsd.toFixed(2)})`,
          )
        } else {
          // Video path: download → color grade → smart crop
          log(`[asset ${index + 1}] Processing video asset...`)
          const videoSrc = tmpSrc! // only null for image assets; guaranteed non-null here
          await getObjectToFile(asset.r2Key, videoSrc)

          const tmpGraded = join(tmpdir(), `fantom-mm-${jobId}-graded-${index}.mp4`)
          tempFiles.push(tmpGraded)

          await applyColorGrade(videoSrc, tmpGraded, 'cinematic')
          await smartCrop(tmpGraded, tmpClip, OUTPUT_WIDTH, OUTPUT_HEIGHT)

          // Optionally extract transcript for quality logging (non-blocking)
          extractSpeechTranscript(tmpClip, { log }).catch(() => undefined)

          log(`[asset ${index + 1}] Video processed`)
        }

        await patchShortsJob(shortsJobId, tenantId, {
          assetRenderStatus: { ...initStatus, [assetId]: { status: 'done' } },
        }).catch(console.error)

        clipPaths[index] = tmpClip
      })

      onProgress(65)
      await checkCancelled()

      // ── 5. Fetch background music ─────────────────────────────────────────
      log('Fetching background music...')
      const musicResult = await fetchMusic(toMusicVibe(musicVibe), voiceDuration, log)
      let tmpMusic: string | null = null
      if (musicResult) {
        tmpMusic = musicResult.filePath
        tempFiles.push(tmpMusic)
      }

      await checkCancelled()

      // ── 6. Download logos ─────────────────────────────────────────────────
      async function downloadKitLogo(kitId: string | null, suffix: string): Promise<string | null> {
        if (!kitId) return null
        try {
          const kit = await getBrandKitRow(kitId, tenantId)
          if (!kit?.logoAssetId) return null
          const logoAsset = await getAssetRow(kit.logoAssetId, tenantId)
          if (!logoAsset) return null
          const ext = getExt(logoAsset.mimeType)
          const path = join(tmpdir(), `fantom-mm-${jobId}-logo-${suffix}.${ext}`)
          await getObjectToFile(logoAsset.r2Key, path)
          tempFiles.push(path)
          return path
        } catch (err) {
          log(`Logo download failed for kit ${kitId} (skipping): ${String(err)}`)
          return null
        }
      }

      const [logoPath, coBrandLogoPath, complianceLogoPath] = await Promise.all([
        downloadKitLogo(brandKitId ?? null, 'primary'),
        downloadKitLogo(coBrandKitId ?? null, 'cobrand'),
        downloadKitLogo(complianceKitId ?? null, 'compliance'),
      ])

      onProgress(70)

      // ── 7. Find font ──────────────────────────────────────────────────────
      const fontPath = await findFontPath()
      if (!fontPath) log('No font file found — using ffmpeg default')

      // ── 8. ffmpeg compose ─────────────────────────────────────────────────
      const tmpOutput = join(tmpdir(), `fantom-mm-${jobId}-output.mp4`)
      tempFiles.push(tmpOutput)

      const drawTextOk = await isDrawTextAvailable()
      if (!drawTextOk) log('drawtext filter unavailable in this ffmpeg build — captions skipped')

      log('Composing final video...')
      const durationSeconds = await buildComposeCommand({
        clipPaths,
        voiceAudio: tmpAudio,
        voiceDuration,
        musicAudio: tmpMusic,
        captionText: drawTextOk ? (captionText ?? null) : null,
        fontPath,
        logoPath,
        coBrandLogoPath,
        complianceLogoPath,
        output: tmpOutput,
        onProgress: (pct) => onProgress(Math.floor(70 + pct * 0.25)),
        checkCancelled,
      })

      onProgress(95)
      log(`Compose complete, duration: ${durationSeconds?.toFixed(1) ?? '?'}s`)

      // ── 9. Upload to R2 ───────────────────────────────────────────────────
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
