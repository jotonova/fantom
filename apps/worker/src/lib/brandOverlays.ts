/**
 * brandOverlays.ts — 1B.8
 *
 * Applies brand-kit overlays to an assembled short video.
 *
 * Pipeline (only runs when brief.brandKitId is set):
 *   1. Generate intro.mp4  — 1.5 s brand splash (bg color + logo + name + tagline)
 *   2. Generate outro.mp4  — 2.5 s brand splash (bg color + logo + name + CTA)
 *   3. Concat intro + scenes + outro → combined.mp4, while simultaneously applying:
 *        • Watermark  — top-right logo, 70 % opacity, persistent
 *        • Lower-third bar — semi-transparent dark strip bottom-left, persistent
 *        • Lower-third logo — 80 px tall logo inside bar
 *      (agent-name text inside the bar is handled by the caption ASS pass)
 *
 * Near-white fallback:
 *   If brand_kit.primary_color has luminance ≥ 0.95 (e.g. Desert ROI #ffffff),
 *   secondary_color is used as the intro/outro background instead. Documented
 *   here because it is non-obvious and intentional.
 *
 * Logo fallback:
 *   If the logo cannot be downloaded (R2 error, asset deleted), overlays render
 *   as text-only — no logo image. A warning is logged; render continues.
 *
 * Returns introDurationMs and outroDurationMs so the handler can shift VO and
 * caption timings by the correct amount.
 */

import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { getObjectToFile } from '@fantom/storage'
import type { BrandKit } from '@fantom/db'

const execFileAsync = promisify(execFile)

export const INTRO_DURATION_MS = 1_500 // 1.5 s
export const OUTRO_DURATION_MS = 2_500 // 2.5 s
const INTRO_DURATION_S = INTRO_DURATION_MS / 1000
const OUTRO_DURATION_S = OUTRO_DURATION_MS / 1000

// ── Colour helpers ─────────────────────────────────────────────────────────────

/** Relative luminance (WCAG approximate) from a '#RRGGBB' hex string. */
function hexLuminance(hex: string): number {
  const clean = hex.replace('#', '')
  if (clean.length !== 6) return 0
  const r = parseInt(clean.slice(0, 2), 16) / 255
  const g = parseInt(clean.slice(2, 4), 16) / 255
  const b = parseInt(clean.slice(4, 6), 16) / 255
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/**
 * Returns the colour to use as the intro/outro frame background.
 * Falls back to secondary_color when primary_color is near-white (≥ 0.95 luminance).
 * Falls back to #1a1a1a (dark neutral) if both are missing or invalid.
 *
 * Desert ROI example: primary=#ffffff → luminance=1.0 ≥ 0.95
 *   → uses secondary=#3c301a (dark brown) instead.
 */
export function resolveFrameBackground(kit: BrandKit): string {
  const primary = kit.primaryColor ?? ''
  if (primary && hexLuminance(primary) < 0.95) return primary
  const secondary = kit.secondaryColor ?? ''
  if (secondary && hexLuminance(secondary) < 0.95) return secondary
  return '#1a1a1a'
}

// ── ASS helpers for intro/outro frames ────────────────────────────────────────

function fmtAss(totalMs: number): string {
  const cs = Math.round(totalMs / 10)
  const c = cs % 100
  const s = Math.floor(cs / 100) % 60
  const m = Math.floor(cs / 6000) % 60
  const h = Math.floor(cs / 360000)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '00')}.${String(c).padStart(2, '00')}`
}

/**
 * Builds a minimal ASS file for a brand splash frame.
 * Uses \pos() override tags for precise placement — Alignment=5 (middle-center)
 * so \pos(x,y) anchors the TEXT CENTER at (x,y) on the 1080×1920 canvas.
 *
 * Logo centred at y ≈ 580 (top at ~280, 300 px tall).
 * brandName at y = 750 (below logo).
 * subText (tagline or CTA) at y = 870.
 */
function buildFrameAss(params: {
  brandName: string
  subText: string
  durationMs: number
  fontName: string
}): string {
  const { brandName, subText, durationMs, fontName } = params
  const end = fmtAss(durationMs)

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Bold=1, Alignment=5 (middle-center), outline 4 px
    `Style: BrandName,${fontName},80,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,4,0,5,10,10,10,1`,
    // Regular weight, lighter colour, outline 3 px
    `Style: SubText,${fontName},50,&H00DDDDDD,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,5,10,10,10,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')

  // Escape text for ASS: { and } are reserved for override blocks
  const escapeName = brandName.replace(/[{}]/g, '')
  const escapeSub = subText.replace(/[{}]/g, '')

  const dialogues = [
    `Dialogue: 0,0:0:00.00,${end},BrandName,,0,0,0,,{\\pos(540,750)}${escapeName}`,
    `Dialogue: 0,0:0:00.00,${end},SubText,,0,0,0,,{\\pos(540,870)}${escapeSub}`,
  ].join('\n')

  return [header, dialogues].join('\n')
}

// ── ffmpeg helpers ─────────────────────────────────────────────────────────────

/**
 * Escapes a path for use in an ffmpeg filtergraph option value.
 * Colons and backslashes must be escaped because ffmpeg's option parser
 * uses ':' as the field separator.
 */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
}

/**
 * Generates a brand splash frame as an MP4 (intro or outro).
 *
 * ffmpeg inputs:
 *   0: color lavfi source (bgColor, 1080×1920, 30 fps, duration)
 *   1: logo PNG (optional — if logoPath is null this input is absent)
 *   2: anullsrc lavfi source (44100 Hz stereo silence, duration)
 *
 * filter_complex:
 *   - If logo present: scale logo height to 300 px, overlay centred at y=280
 *   - Then burn ASS text via fontsdir-based libass
 */
async function generateSplashFrame(opts: {
  ffmpegBin: string
  bgColor: string
  logoPath: string | null
  assPath: string
  fontDir: string
  durationS: number
  outputPath: string
  log: (msg: string) => void
}): Promise<void> {
  const { ffmpegBin, bgColor, logoPath, assPath, fontDir, durationS, outputPath, log } = opts

  const args: string[] = []

  // Input 0: solid colour background
  args.push(
    '-f', 'lavfi',
    '-i', `color=c=${bgColor}:s=1080x1920:r=30:d=${durationS}`,
  )

  // Input 1 (optional): logo
  let logoInputIdx: number | null = null
  if (logoPath) {
    logoInputIdx = 1
    args.push('-loop', '1', '-i', logoPath)
  }

  // Input for silence — aevalsrc with explicit duration so ffmpeg has a bounded
  // source and doesn't require -t to terminate. anullsrc is infinite and has
  // caused hangs on Render containers where -t wasn't always respected.
  const silenceIdx = logoPath ? 2 : 1
  args.push('-f', 'lavfi', '-i', `aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${durationS}`)

  // Build filter_complex
  const escapedAss = escapeFilterPath(assPath)
  const escapedFontDir = escapeFilterPath(fontDir)
  const assFilter = `ass=${escapedAss}:fontsdir=${escapedFontDir}`

  let filterComplex: string
  if (logoInputIdx !== null) {
    filterComplex = [
      `[${logoInputIdx}:v]scale=-1:300[logo_s]`,
      `[0:v][logo_s]overlay=(W-w)/2:280[with_logo]`,
      `[with_logo]${assFilter}[out]`,
    ].join(';')
  } else {
    filterComplex = `[0:v]${assFilter}[out]`
  }

  args.push(
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-map', `${silenceIdx}:a`,
    '-t', String(durationS),
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-r', '30',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  )

  log(`  splash: ${durationS}s, bg=${bgColor}, logo=${logoPath ? 'yes' : 'none (text-only)'}`)
  try {
    await execFileAsync(ffmpegBin, args, {
      timeout: 300_000,
      killSignal: 'SIGKILL', // SIGTERM can be ignored by hung ffmpeg; SIGKILL cannot
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.slice(-2000) ?? ''
    log(`  splash ffmpeg FAILED:\n${stderr || String(err)}`)
    throw err
  }
}

/**
 * Concatenates intro + scenes + outro into a single MP4, and simultaneously
 * applies watermark (top-right) and lower-third dark bar + logo (bottom-left).
 *
 * ffmpeg inputs:
 *   0: intro.mp4
 *   1: scenes.mp4  (the assembled + audio-mixed base video)
 *   2: outro.mp4
 *   3: logo.png (static, looped — used for both watermark and lower-third logo)
 *
 * filter_complex:
 *   [0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[cv][ca]
 *   [3:v]split[lsrc][wsrc]
 *   [lsrc]scale=-1:80[ltlogo]       — lower-third logo, 80 px tall
 *   [cv]drawbox=x=140:y=ih-290:w=iw-280:h=100:color=black@0.4:t=fill[barred]
 *   [barred][ltlogo]overlay=150:H-270[ltdone]
 *   [wsrc]scale=-1:60,format=rgba,colorchannelmixer=aa=0.7[wm]
 *   [ltdone][wm]overlay=W-w-80:80[outv]
 *
 * If no logo is available, watermark and lower-third logo overlays are skipped
 * (only the dark bar is drawn).
 */
async function concatAndOverlay(opts: {
  ffmpegBin: string
  introPath: string
  scenesPath: string
  outroPath: string
  logoPath: string | null
  outputPath: string
  log: (msg: string) => void
}): Promise<void> {
  const { ffmpegBin, introPath, scenesPath, outroPath, logoPath, outputPath, log } = opts

  const args: string[] = [
    '-i', introPath,
    '-i', scenesPath,
    '-i', outroPath,
  ]

  let logoInputIdx: number | null = null
  if (logoPath) {
    logoInputIdx = 3
    args.push('-loop', '1', '-i', logoPath)
  }

  // Build filter
  const concatStep = '[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[cv][ca]'

  let overlayChain: string
  if (logoInputIdx !== null) {
    overlayChain = [
      `[${logoInputIdx}:v]split[lsrc][wsrc]`,
      `[lsrc]scale=-1:80[ltlogo]`,
      `[cv]drawbox=x=140:y=ih-290:w=iw-280:h=100:color=black@0.4:t=fill[barred]`,
      `[barred][ltlogo]overlay=150:H-270[ltdone]`,
      `[wsrc]scale=-1:60[wm]`,
      `[ltdone][wm]overlay=W-w-80:80[outv]`,
    ].join(';')
  } else {
    // No logo: just the dark bar, no image overlays
    overlayChain = `[cv]drawbox=x=140:y=ih-290:w=iw-280:h=100:color=black@0.4:t=fill[outv]`
  }

  args.push(
    '-filter_complex', [concatStep, overlayChain].join(';'),
    '-map', '[outv]',
    '-map', '[ca]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-r', '30',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  )

  log(`  concat+overlay: intro(${INTRO_DURATION_S}s) + scenes + outro(${OUTRO_DURATION_S}s)`)
  try {
    await execFileAsync(ffmpegBin, args, {
      timeout: 600_000,
      killSignal: 'SIGKILL',
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.slice(-2000) ?? ''
    log(`  concat ffmpeg FAILED:\n${stderr || String(err)}`)
    throw err
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface BrandOverlayResult {
  outputPath: string
  introDurationMs: number
  outroDurationMs: number
  agentName: string
  hadLogo: boolean
}

/**
 * Applies brand overlays to the assembled video.
 *
 * @param scenesPath  Path to the scenes-only MP4 (post-assembly, post-audio-mix).
 * @param brandKit    Full brand_kit row (tagline + agentName fields required for overlays).
 * @param logoR2Key   R2 key for the logo asset, or null if no logo asset is linked.
 * @param ctaText     CTA text for the outro frame. Falls back to brandKit.tagline.
 * @param workDir     Per-render scratch directory.
 * @param fontDir     Absolute path to the fontsdir containing NotoSans-Regular.ttf.
 * @param ffmpegBin   Path to the ffmpeg binary to use.
 * @param log         Logging callback.
 */
export async function applyBrandOverlays(opts: {
  scenesPath: string
  brandKit: BrandKit
  logoR2Key: string | null
  ctaText: string | null
  workDir: string
  fontDir: string
  ffmpegBin: string
  log: (msg: string) => void
}): Promise<BrandOverlayResult> {
  const { scenesPath, brandKit, logoR2Key, ctaText, workDir, fontDir, ffmpegBin, log } = opts

  log(`[brandOverlays] START kit="${brandKit.name}" id=${brandKit.id}`)

  const overlayDir = join(workDir, 'brand')
  await mkdir(overlayDir, { recursive: true })
  log(`[brandOverlays] workdir ready: ${overlayDir}`)

  // ── Download logo ────────────────────────────────────────────────────────────

  let logoPath: string | null = null
  if (logoR2Key) {
    const dest = join(overlayDir, 'logo.png')
    try {
      await getObjectToFile(logoR2Key, dest)
      logoPath = dest
      log(`  logo downloaded: ${logoR2Key}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`  WARNING: logo download failed (${msg}) — text-only overlays`)
    }
  } else {
    log(`  no logo asset — text-only overlays`)
  }

  // ── Resolve colours and text ─────────────────────────────────────────────────

  const bgColor = resolveFrameBackground(brandKit)
  const displayName = brandKit.agentName ?? brandKit.name
  const tagline = brandKit.tagline ?? ''
  const cta = ctaText?.trim() || tagline || 'Contact Us Today'
  const fontName = 'Noto Sans'

  log(`  bg=${bgColor}, name="${displayName}", tagline="${tagline}", cta="${cta}"`)

  // ── Generate intro frame ─────────────────────────────────────────────────────

  log(`[brandOverlays] generating intro frame (${INTRO_DURATION_S}s)…`)
  const introAssPath = join(overlayDir, 'intro.ass')
  await writeFile(
    introAssPath,
    buildFrameAss({ brandName: displayName, subText: tagline, durationMs: INTRO_DURATION_MS, fontName }),
    'utf-8',
  )

  const introPath = join(overlayDir, 'intro.mp4')
  await generateSplashFrame({
    ffmpegBin,
    bgColor,
    logoPath,
    assPath: introAssPath,
    fontDir,
    durationS: INTRO_DURATION_S,
    outputPath: introPath,
    log,
  })
  log(`  intro.mp4 generated`)

  // ── Generate outro frame ─────────────────────────────────────────────────────

  log(`[brandOverlays] generating outro frame (${OUTRO_DURATION_S}s)…`)
  const outroAssPath = join(overlayDir, 'outro.ass')
  await writeFile(
    outroAssPath,
    buildFrameAss({ brandName: displayName, subText: cta, durationMs: OUTRO_DURATION_MS, fontName }),
    'utf-8',
  )

  const outroPath = join(overlayDir, 'outro.mp4')
  await generateSplashFrame({
    ffmpegBin,
    bgColor,
    logoPath,
    assPath: outroAssPath,
    fontDir,
    durationS: OUTRO_DURATION_S,
    outputPath: outroPath,
    log,
  })
  log(`  outro.mp4 generated`)

  // ── Concat intro + scenes + outro, apply watermark + lower-third ─────────────

  log(`[brandOverlays] concat+overlay pass…`)
  const brandedPath = join(workDir, 'branded.mp4')
  await concatAndOverlay({
    ffmpegBin,
    introPath,
    scenesPath,
    outroPath,
    logoPath,
    outputPath: brandedPath,
    log,
  })
  log(`  branded.mp4 complete`)

  return {
    outputPath: brandedPath,
    introDurationMs: INTRO_DURATION_MS,
    outroDurationMs: OUTRO_DURATION_MS,
    agentName: displayName,
    hadLogo: logoPath !== null,
  }
}
