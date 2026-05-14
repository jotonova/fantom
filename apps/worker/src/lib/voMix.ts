/**
 * voMix — VO audio mix step
 *
 * Given an assembled video and one or more VO audio segments with pre-computed
 * start offsets:
 *   1. Each VO file is fed as a separate ffmpeg input, delayed to its clip
 *      position using `adelay`.
 *   2. All delayed VO tracks are merged into a single VO bus via amix.
 *   3. The VO bus is padded with silence to video length (apad) so the
 *      sidechain compressor runs for the full video — without apad,
 *      sidechaincompress terminates when the shortest VO input exhausts,
 *      silencing all audio past that point.
 *   4. Source audio is sidechain-compressed (ducked) whenever the VO bus is
 *      audible, then mixed back with the VO bus.
 *   5. When a music track is provided, it is looped/trimmed to video length,
 *      sidechain-compressed under the VO bus, and mixed in as a background layer.
 *   6. Output is loudnorm-normalized to -16 LUFS.
 *   7. Video stream is copied — no re-encode.
 *
 * Filter graph without music (N VO inputs):
 *   [1:a]adelay=T1ms:all=1,aformat=channel_layouts=stereo[vo_del_0]
 *   ...
 *   [N:a]adelay=TNms:all=1,aformat=channel_layouts=stereo[vo_del_N-1]
 *   [vo_del_0]...[vo_del_N-1]amix=inputs=N:duration=longest:normalize=0[vo_bus]
 *     (or [vo_del_0]anull[vo_bus] when N=1)
 *   [vo_bus]apad[vo_padded]
 *   [vo_padded]asplit[vo_mix][vo_sc]
 *   [0:a][vo_sc]sidechaincompress=threshold=0.02:ratio=10:attack=5:release=200[src_ducked]
 *   [src_ducked][vo_mix]amix=inputs=2:duration=first:normalize=0[mixed]
 *   [mixed]loudnorm=I=-16:TP=-1.5:LRA=11[normed]
 *
 * Filter graph with music (N VO inputs + 1 music input at index N+1):
 *   ... (same VO bus construction) ...
 *   [vo_bus]apad[vo_padded]
 *   [vo_padded]asplit=3[vo_mix][vo_sc][vo_music_sc]
 *   [0:a][vo_sc]sidechaincompress=threshold=0.02:ratio=10:attack=5:release=200[src_ducked]
 *   [M:a]aloop=loop=-1:size=0,atrim=end=D,asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo[music_looped]
 *   [music_looped]volume=0.3[music_vol]
 *   [music_vol][vo_music_sc]sidechaincompress=threshold=0.015:ratio=4:attack=10:release=500[music_ducked]
 *   [src_ducked][vo_mix][music_ducked]amix=inputs=3:duration=first:normalize=0[mixed]
 *   [mixed]loudnorm=I=-16:TP=-1.5:LRA=11[normed]
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { VOFile } from './generateVO.js'

const execFileAsync = promisify(execFile)

const MIX_TIMEOUT_MS = 5 * 60_000

// ── Types ─────────────────────────────────────────────────────────────────────

/** VOFile extended with a clip-position-based start offset for adelay. */
export interface VOFileWithOffset extends VOFile {
  /** Milliseconds from the start of the assembled video at which this VO begins. */
  startOffsetMs: number
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Mix VO over an assembled video using per-segment clip-position offsets.
 * Optionally includes a background music layer that is sidechain-ducked under VO.
 *
 * @param videoPath           Path to the assembled MP4 (output of assembleShortFromBrief)
 * @param voFiles             VO segments with pre-computed clip-position start offsets
 * @param workDir             Working directory for temp files
 * @param log                 Render-scoped logger
 * @param music               Optional music layer: local path + video duration for trim
 * @returns                   Path to the mixed MP4 (different file from videoPath)
 */
export async function mixVoiceover(opts: {
  videoPath: string
  voFiles: VOFileWithOffset[]
  workDir: string
  log: (msg: string) => void
  music?: { localPath: string; slug: string; videoDurationSeconds: number }
}): Promise<string> {
  const { videoPath, voFiles, workDir, log, music } = opts

  if (voFiles.length === 0 && !music) return videoPath

  const mixedPath = join(workDir, 'output_mixed.mp4')

  if (voFiles.length > 0) {
    log(
      `mixing ${voFiles.length} VO segment(s): ` +
        voFiles.map((f) => `${f.sceneId}@${(f.startOffsetMs / 1000).toFixed(2)}s`).join(', '),
    )
  }
  if (music) {
    log(`adding music layer: ${music.slug} (${music.videoDurationSeconds}s trim)`)
  }

  // ── Build ffmpeg args ─────────────────────────────────────────────────────
  // Input 0 = video; inputs 1..N = VO files in voFiles order; N+1 = music (if any).

  const args: string[] = ['-i', videoPath]
  for (const vf of voFiles) {
    args.push('-i', vf.audioPath)
  }
  const musicInputIdx = voFiles.length + 1 // only valid when music != null
  if (music) {
    args.push('-i', music.localPath)
  }

  // ── filter_complex ────────────────────────────────────────────────────────

  const filterLines: string[] = []

  // ── VO bus ────────────────────────────────────────────────────────────────
  // When there are no VO files but music is requested, synthesize a silent VO bus
  // using aevalsrc so the sidechain path still works without modification.
  if (voFiles.length === 0) {
    // No VO — create a silent placeholder to keep the filter graph consistent.
    // Duration is capped to video length via atrim; it acts as a pass-through.
    const dur = music!.videoDurationSeconds
    filterLines.push(
      `aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${dur}[vo_bus]`,
    )
  } else {
    const voDelayedPads: string[] = []
    for (let i = 0; i < voFiles.length; i++) {
      const vf = voFiles[i]!
      const inputIdx = i + 1 // input 0 = video
      const delayMs = Math.max(0, Math.round(vf.startOffsetMs))
      const padLabel = `[vo_del_${i}]`

      // adelay positions the segment at the correct clip offset.
      // aformat upmixes mono ElevenLabs MP3s to stereo so they're compatible
      // with the stereo source audio going into sidechaincompress and amix.
      filterLines.push(
        `[${inputIdx}:a]adelay=${delayMs}:all=1,aformat=channel_layouts=stereo${padLabel}`,
      )
      voDelayedPads.push(padLabel)
    }

    // Merge all delayed VO tracks into a single VO bus.
    if (voFiles.length === 1) {
      filterLines.push(`${voDelayedPads[0]}anull[vo_bus]`)
    } else {
      filterLines.push(
        `${voDelayedPads.join('')}amix=inputs=${voFiles.length}:duration=longest:normalize=0[vo_bus]`,
      )
    }
  }

  // apad → VO bus padded to video length so sidechaincompress never terminates early.
  filterLines.push('[vo_bus]apad[vo_padded]')

  if (music) {
    // Three-output asplit: [vo_mix] → final mix, [vo_sc] → source duck, [vo_music_sc] → music duck.
    filterLines.push('[vo_padded]asplit=3[vo_mix][vo_sc][vo_music_sc]')

    // Source audio ducked under VO.
    filterLines.push(
      '[0:a][vo_sc]sidechaincompress=threshold=0.02:ratio=10:attack=5:release=200[src_ducked]',
    )

    // Music: loop indefinitely → trim to video duration → reset timestamps → stereo.
    const dur = music.videoDurationSeconds
    filterLines.push(
      `[${musicInputIdx}:a]aloop=loop=-1:size=0,atrim=end=${dur},asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo[music_looped]`,
    )
    // Lower music volume, then duck it under VO (gentle sidechain).
    filterLines.push('[music_looped]volume=0.18[music_vol]')
    filterLines.push(
      '[music_vol][vo_music_sc]sidechaincompress=threshold=0.015:ratio=4:attack=10:release=500[music_ducked]',
    )

    // Three-layer final mix: source + VO + music. duration=first clips to source length.
    filterLines.push(
      '[src_ducked][vo_mix][music_ducked]amix=inputs=3:duration=first:normalize=0[mixed]',
    )
  } else {
    // Two-output asplit: [vo_mix] → final mix, [vo_sc] → source duck.
    filterLines.push('[vo_padded]asplit[vo_mix][vo_sc]')

    // sidechaincompress → ducks source audio ~-18dB while any VO is audible.
    // amix duration=first → output length = video length (first = [src_ducked]).
    filterLines.push(
      '[0:a][vo_sc]sidechaincompress=threshold=0.02:ratio=10:attack=5:release=200[src_ducked]',
    )
    filterLines.push('[src_ducked][vo_mix]amix=inputs=2:duration=first:normalize=0[mixed]')
  }

  // loudnorm → EBU R128 -16 LUFS, -1.5dBTP.
  filterLines.push('[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[normed]')

  args.push(
    '-filter_complex', filterLines.join(';'),
    '-map', '0:v',
    '-map', '[normed]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    '-y',
    mixedPath,
  )

  log(`ffmpeg (vo mix) args: ${args.join(' ')}`)

  try {
    const { stderr } = await execFileAsync('ffmpeg', args, {
      timeout: MIX_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    })
    log(`mix complete (${(stderr ?? '').split('\n').pop()?.trim() ?? ''})`)
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
    const tail = (e.stderr ?? '').slice(-2048)
    if (e.killed || String(e.code) === 'ETIMEDOUT') {
      throw new Error(`ffmpeg VO mix timed out after ${MIX_TIMEOUT_MS / 1000}s`)
    }
    throw new Error(`ffmpeg VO mix failed:\n${tail || e.message}`)
  }

  return mixedPath
}
