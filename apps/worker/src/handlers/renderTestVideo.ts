import { promises as fs } from 'node:fs'
import { db, jobs, assets, voiceClones, tenants } from '@fantom/db'
import type { Job as DbJob, Asset } from '@fantom/db'
import { buildKey, putObjectFromFile, getObjectToFile, getPublicUrl } from '@fantom/storage'
import { synthesize } from '@fantom/voice'
import { eq, sql } from 'drizzle-orm'
import Ffmpeg from 'fluent-ffmpeg'
import { createRequire } from 'node:module'

// ffmpeg-static is CJS; use createRequire so NodeNext module resolution finds it
const _require = createRequire(import.meta.url)
const ffmpegBinary = _require('ffmpeg-static') as string | null
if (ffmpegBinary) Ffmpeg.setFfmpegPath(ffmpegBinary)

// ── Cancellation ──────────────────────────────────────────────────────────────

export class CancelledError extends Error {
  constructor() {
    super('Job was cancelled')
    this.name = 'CancelledError'
  }
}

// ── Input type ────────────────────────────────────────────────────────────────

interface RenderTestVideoInput {
  voiceCloneId: string
  text: string
  imageAssetId: string
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function getJobRow(jobId: string, tenantId: string): Promise<DbJob | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [row] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
    return row
  })
}

async function patchJob(
  jobId: string,
  tenantId: string,
  values: Partial<typeof jobs.$inferInsert>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    await tx
      .update(jobs)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(jobs.id, jobId))
  })
}

async function setProgress(jobId: string, tenantId: string, pct: number): Promise<void> {
  await patchJob(jobId, tenantId, { progress: Math.min(Math.max(0, pct), 100) })
}

async function checkCancelled(jobId: string, tenantId: string): Promise<void> {
  const row = await getJobRow(jobId, tenantId)
  if (row?.status === 'cancelled') throw new CancelledError()
}

async function getAssetRow(assetId: string, tenantId: string): Promise<Asset | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [row] = await tx.select().from(assets).where(eq(assets.id, assetId)).limit(1)
    return row
  })
}

async function getTenantSlug(tenantId: string): Promise<string> {
  // tenants has RLS — set the GUC before querying
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [r] = await tx
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
    return r
  })
  if (!row) throw new Error(`Tenant ${tenantId} not found`)
  return row.slug
}

async function createAssetRecord(params: {
  tenantId: string
  kind: 'audio' | 'video'
  r2Key: string
  originalFilename: string
  mimeType: string
  sizeBytes: number
  durationSeconds?: number | null
  width?: number | null
  height?: number | null
}): Promise<Asset> {
  const asset = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${params.tenantId}, true)`)
    const [row] = await tx
      .insert(assets)
      .values({
        tenantId: params.tenantId,
        uploadedByUserId: null,
        kind: params.kind,
        originalFilename: params.originalFilename,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
        r2Key: params.r2Key,
        durationSeconds:
          params.durationSeconds != null ? String(params.durationSeconds) : null,
        width: params.width ?? null,
        height: params.height ?? null,
        tags: [],
      })
      .returning()
    return row
  })
  if (!asset) throw new Error('Failed to create asset record')
  return asset
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
        '-preset', 'veryfast',   // good speed/quality balance; upgrade to 'medium' for F7+ quality tiers
        '-tune', 'stillimage',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-pix_fmt', 'yuv420p',
        '-shortest',
        '-movflags', '+faststart',
      ])
      .videoFilter(
        // 1080p — production quality; Standard tier (2 GB RAM) handles this comfortably
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
      // Parse duration from the last timemark emitted by ffmpeg
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
// Prefixes the thrown error message with [step-name] so the error_message
// column in the DB immediately identifies which outbound call failed.

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`[${label}] ${msg}`)
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function renderTestVideoHandler(opts: {
  jobId: string
  tenantId: string
  attemptsMade: number
}): Promise<void> {
  const { jobId, tenantId, attemptsMade } = opts

  const tmpImage = `/tmp/fantom-job-${jobId}-image`
  const tmpAudio = `/tmp/fantom-job-${jobId}-audio.mp3`
  const tmpOutput = `/tmp/fantom-job-${jobId}-output.mp4`

  try {
    // ── Step 1: Read job from DB ───────────────────────────────────────────────

    const job = await getJobRow(jobId, tenantId)
    if (!job) throw new Error(`Job ${jobId} not found`)

    const input = job.input as unknown as RenderTestVideoInput
    if (!input.voiceCloneId || !input.text || !input.imageAssetId) {
      throw new Error('Invalid job input: voiceCloneId, text, and imageAssetId are required')
    }

    // Mark as processing
    await patchJob(jobId, tenantId, { status: 'processing', startedAt: new Date() })
    await checkCancelled(jobId, tenantId)

    // ── Step 2: Fetch voice clone and image asset ──────────────────────────────

    const voiceClone = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx
        .select()
        .from(voiceClones)
        .where(eq(voiceClones.id, input.voiceCloneId))
        .limit(1)
      return row
    })
    if (!voiceClone) throw new Error(`Voice clone ${input.voiceCloneId} not found`)
    if (!voiceClone.providerVoiceId) throw new Error('Voice clone has no provider voice ID')
    const providerVoiceId = voiceClone.providerVoiceId

    const imageAsset = await getAssetRow(input.imageAssetId, tenantId)
    if (!imageAsset) throw new Error(`Image asset ${input.imageAssetId} not found`)

    const tenantSlug = await getTenantSlug(tenantId)

    logMem('start')
    await setProgress(jobId, tenantId, 10)

    // ── Step 3: Synthesize audio → write to disk immediately ──────────────────
    // Buffer is created and written inside the async closure so it exits scope
    // (and becomes GC-eligible) before R2 upload and ffmpeg begin.

    logMem('before-synthesize')
    const audioSizeBytes = await step('elevenlabs-synthesize', async () => {
      const buf = await synthesize({ text: input.text, voiceId: providerVoiceId })
      await fs.writeFile(tmpAudio, buf)
      return buf.byteLength
    })
    logMem('after-synthesize')
    await checkCancelled(jobId, tenantId)

    // ── Step 4: Stream audio from disk to R2 ──────────────────────────────────

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
    console.log(`fantom-worker: audio asset created ${audioAsset.id}`)

    await setProgress(jobId, tenantId, 30)
    await checkCancelled(jobId, tenantId)

    // ── Step 5: Stream image from R2 directly to disk (no Buffer in heap) ─────

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

    await setProgress(jobId, tenantId, 40)
    await checkCancelled(jobId, tenantId)

    // ── Step 6: Run ffmpeg (image + audio → MP4, 720p) ────────────────────────

    logMem('before-ffmpeg')

    // Poll DB every 2 s during encoding — abort and surface CancelledError if status changed
    const ffmpegAbort = new AbortController()
    const ffmpegPollInterval = setInterval(() => {
      void getJobRow(jobId, tenantId).then((row) => {
        if (row?.status === 'cancelled') ffmpegAbort.abort()
      }).catch(console.error)
    }, 2000)

    let durationSeconds: number | null
    try {
      durationSeconds = await runFfmpeg(
        tmpImageWithExt,
        tmpAudio,
        tmpOutput,
        (pct) => {
          const dbPct = Math.floor(40 + pct * 0.5)
          setProgress(jobId, tenantId, Math.min(dbPct, 90)).catch(console.error)
        },
        ffmpegAbort.signal,
      )
    } finally {
      clearInterval(ffmpegPollInterval)
    }

    logMem('after-ffmpeg')

    await setProgress(jobId, tenantId, 90)

    // ── Step 7: Stream MP4 from disk to R2 (no fs.readFile into heap) ─────────

    const { size: videoSizeBytes } = await fs.stat(tmpOutput)
    const videoKey = buildKey(tenantSlug, 'video', `job-${jobId}-render.mp4`)
    logMem('before-r2-put-video')
    await step('r2-put-video', () => putObjectFromFile(videoKey, tmpOutput, 'video/mp4'))
    logMem('after-r2-put-video')

    const videoAsset = await createAssetRecord({
      tenantId,
      kind: 'video',
      r2Key: videoKey,
      originalFilename: `job-${jobId}-render.mp4`,
      mimeType: 'video/mp4',
      sizeBytes: videoSizeBytes,
      durationSeconds,
      width: 1920,
      height: 1080,
    })

    console.log(
      `fantom-worker: video asset created ${videoAsset.id} — ${getPublicUrl(videoKey)}`,
    )

    // ── Step 9: Mark job complete ──────────────────────────────────────────────

    await patchJob(jobId, tenantId, {
      status: 'completed',
      progress: 100,
      outputAssetId: videoAsset.id,
      completedAt: new Date(),
    })
  } catch (err) {
    // ── Cancelled mid-flight ───────────────────────────────────────────────────
    // DB already shows 'cancelled' (set by the API). Skip retry logic; let the
    // dispatcher swallow the error so BullMQ marks the job completed cleanly.

    if (err instanceof CancelledError) {
      console.log(`[job:cancelled] job ${jobId} cancelled mid-flight — cleaning up`)
      throw err
    }

    // ── Error handling with retry logic ────────────────────────────────────────

    const errMessage = err instanceof Error ? err.message : String(err)
    const errStack = err instanceof Error ? (err.stack ?? null) : null

    const job = await getJobRow(jobId, tenantId).catch(() => undefined)
    const maxRetries = job?.maxRetries ?? 2
    const newRetries = attemptsMade + 1

    if (newRetries < maxRetries) {
      // BullMQ will retry — set status back to queued
      await patchJob(jobId, tenantId, {
        status: 'queued',
        retries: newRetries,
        errorMessage: errMessage,
      }).catch(console.error)
    } else {
      // Final failure — mark as failed
      await patchJob(jobId, tenantId, {
        status: 'failed',
        retries: newRetries,
        errorMessage: errMessage,
        errorStack: errStack,
      }).catch(console.error)
    }

    throw err // Let BullMQ handle its own retry/fail tracking
  } finally {
    // ── Cleanup temp files ────────────────────────────────────────────────────

    const tmpFiles = [
      `${tmpImage}.jpg`,
      `${tmpImage}.png`,
      `${tmpImage}.webp`,
      `${tmpImage}.gif`,
      tmpAudio,
      tmpOutput,
    ]
    for (const f of tmpFiles) {
      await fs.unlink(f).catch(() => {
        // Ignore — file may not have been created yet
      })
    }
  }
}
