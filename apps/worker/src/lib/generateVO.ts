/**
 * generateVO — ElevenLabs TTS per scene with R2 caching
 *
 * - Generates audio for each scene that has a voiceover_script.
 * - Caches results in R2 keyed by SHA-256(voiceId + text) so identical scripts
 *   across briefs or re-renders never hit the ElevenLabs API twice.
 * - Each synthesis call has a 60s timeout with one automatic retry.
 * - Cache write failures are non-fatal (logged only).
 */

import crypto from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { synthesize } from '@fantom/voice'
import { putObject, getObjectBuffer } from '@fantom/storage'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SceneVO {
  id: string
  voiceover_script: string
}

export interface VOFile {
  sceneId: string
  audioPath: string // absolute path to local .mp3 file
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SYNTH_TIMEOUT_MS = 60_000
const SYNTH_RETRY_DELAY_MS = 2_000

// ── Helpers ───────────────────────────────────────────────────────────────────

async function synthesizeWithRetry(text: string, voiceId: string): Promise<Buffer> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await Promise.race([
        synthesize({ text, voiceId }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`ElevenLabs synthesize timeout after ${SYNTH_TIMEOUT_MS}ms`)),
            SYNTH_TIMEOUT_MS,
          ),
        ),
      ])
    } catch (err) {
      lastErr = err
      if (attempt < 2) await new Promise((r) => setTimeout(r, SYNTH_RETRY_DELAY_MS))
    }
  }
  throw lastErr
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate TTS audio files for scenes with voiceover_script text.
 *
 * @param scenes    Scenes that have a voiceover_script (caller filters blanks)
 * @param voiceId   ElevenLabs voice ID (providerVoiceId)
 * @param tenantSlug  Used for R2 cache key prefix
 * @param workDir   Temp directory for local audio files
 * @param log       Render-scoped logger
 * @returns         Array of {sceneId, audioPath} — one entry per synthesized scene
 */
export async function generateVO(opts: {
  scenes: SceneVO[]
  voiceId: string
  tenantSlug: string
  workDir: string
  log: (msg: string) => void
}): Promise<VOFile[]> {
  const { scenes, voiceId, tenantSlug, workDir, log } = opts
  const result: VOFile[] = []

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!
    const text = scene.voiceover_script.trim()
    if (!text) continue

    // Cache key: deterministic hash of (voiceId + text)
    const hash = crypto
      .createHash('sha256')
      .update(`${voiceId}|${text}`)
      .digest('hex')
      .slice(0, 32)

    const cacheKey = `${tenantSlug}/vo-cache/${hash}.mp3`
    const localPath = join(workDir, `vo-scene-${i}.mp3`)

    // ── Try R2 cache ──────────────────────────────────────────────────────────
    let audioBuffer: Buffer | null = null
    try {
      audioBuffer = await getObjectBuffer(cacheKey)
      log(`  [vo ${i + 1}/${scenes.length}] cache hit ${hash.slice(0, 8)}… (${text.length} chars)`)
    } catch {
      // Cache miss — fall through to synthesis
    }

    // ── Synthesize ────────────────────────────────────────────────────────────
    if (!audioBuffer) {
      log(`  [vo ${i + 1}/${scenes.length}] synthesizing ${text.length} chars via ElevenLabs`)
      audioBuffer = await synthesizeWithRetry(text, voiceId)

      // Write to R2 cache — fail-soft so a cache error never aborts the render
      putObject(cacheKey, audioBuffer, 'audio/mpeg').catch((err) => {
        log(
          `  [vo ${i + 1}] WARNING: R2 cache write failed — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }

    await writeFile(localPath, audioBuffer)
    result.push({ sceneId: scene.id, audioPath: localPath })
  }

  return result
}
