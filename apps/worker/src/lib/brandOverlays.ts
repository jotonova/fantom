/**
 * brandOverlays.ts — 1B.8
 *
 * Applies a persistent brand watermark to an assembled short video.
 *
 * Pipeline (only runs when brief.brandKitId is set AND a logo asset exists):
 *   1. Download logo PNG from R2
 *   2. Overlay logo in the top-right corner at 90 px tall, persistent throughout
 *
 * No intro/outro splash frames. No lower-third bar. Watermark only.
 *
 * Logo fallback:
 *   If the logo cannot be downloaded (R2 error, asset deleted), the overlay pass
 *   is skipped and scenesPath is returned as-is. A warning is logged; render
 *   continues unbranded.
 *
 * Returns introDurationMs: 0 and outroDurationMs: 0 always — no timing shifts
 * are needed for VO, captions, or music.
 */

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { getObjectToFile } from '@fantom/storage'
import type { BrandKit } from '@fantom/db'

const execFileAsync = promisify(execFile)

// ── Public API ─────────────────────────────────────────────────────────────────

export interface BrandOverlayResult {
  outputPath: string
  introDurationMs: 0
  outroDurationMs: 0
  hadLogo: boolean
}

/**
 * Applies a brand watermark to the assembled video.
 *
 * ffmpeg inputs:
 *   0: scenesPath (the assembled MP4)
 *   1: logo.png   (single frame — eof_action=repeat holds it for full duration)
 *
 * filter_complex:
 *   [1:v]scale=-1:90[wm]
 *   [0:v][wm]overlay=W-w-40:40[outv]
 *
 * Placement: top-right, 40 px from each edge. 90 px tall logo.
 * Audio is copied untouched (-c:a copy).
 *
 * @param scenesPath  Path to the scenes-only MP4 (post-assembly, post-audio-mix).
 * @param brandKit    Full brand_kit row.
 * @param logoR2Key   R2 key for the logo asset, or null if no logo asset is linked.
 * @param workDir     Per-render scratch directory.
 * @param ffmpegBin   Path to the ffmpeg binary to use.
 * @param log         Logging callback.
 */
export async function applyBrandOverlays(opts: {
  scenesPath: string
  brandKit: BrandKit
  logoR2Key: string | null
  ctaText: string | null   // kept in signature for call-site compatibility; unused
  workDir: string
  fontDir: string          // kept in signature for call-site compatibility; unused
  ffmpegBin: string
  log: (msg: string) => void
}): Promise<BrandOverlayResult> {
  const { scenesPath, brandKit, logoR2Key, workDir, ffmpegBin, log } = opts

  log(`[brandOverlays] START kit="${brandKit.name}" id=${brandKit.id}`)

  // No logo → nothing to overlay; return input path unchanged.
  if (!logoR2Key) {
    log(`  no logo asset — skipping watermark`)
    return { outputPath: scenesPath, introDurationMs: 0, outroDurationMs: 0, hadLogo: false }
  }

  const overlayDir = join(workDir, 'brand')
  await mkdir(overlayDir, { recursive: true })

  // ── Download logo ────────────────────────────────────────────────────────────

  const logoPath = join(overlayDir, 'logo.png')
  try {
    await getObjectToFile(logoR2Key, logoPath)
    log(`  logo downloaded: ${logoR2Key}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`  WARNING: logo download failed (${msg}) — skipping watermark`)
    return { outputPath: scenesPath, introDurationMs: 0, outroDurationMs: 0, hadLogo: false }
  }

  // ── Apply watermark ──────────────────────────────────────────────────────────
  // Single overlay pass: scale logo to 90 px tall, place top-right with 40 px margin.
  // The PNG is a single frame; eof_action=repeat (overlay default) holds it
  // for the full duration of the base video stream.
  // -c:a copy — audio untouched, no re-encode.

  const watemarkedPath = join(workDir, 'branded.mp4')

  const filterComplex = [
    '[1:v]scale=-1:90[wm]',
    '[0:v][wm]overlay=W-w-40:40[outv]',
  ].join(';')

  const args: string[] = [
    '-i', scenesPath,
    '-i', logoPath,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-map', '0:a',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y',
    watemarkedPath,
  ]

  log(`  watermark: logo 90px tall, top-right (W-w-40:40)`)
  try {
    await execFileAsync(ffmpegBin, args, {
      timeout: 600_000,
      killSignal: 'SIGKILL',
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.slice(-2000) ?? ''
    log(`  watermark ffmpeg FAILED:\n${stderr || String(err)}`)
    throw err
  }

  log(`  branded.mp4 complete`)
  return { outputPath: watemarkedPath, introDurationMs: 0, outroDurationMs: 0, hadLogo: true }
}
