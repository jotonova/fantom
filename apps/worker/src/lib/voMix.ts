/**
 * voMix — VO audio mix step
 *
 * Given an assembled video and one or more VO audio segments:
 *   1. Concatenates segments into a single VO track (if >1)
 *   2. Uses sidechain compression to duck source audio to ~-18dB when VO is audible
 *   3. Mixes ducked source + VO and normalizes output to -16 LUFS
 *   4. Returns the path of the mixed MP4 (re-encodes audio only; copies video stream)
 */

import { execFile } from 'node:child_process'
import { copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { VOFile } from './generateVO.js'

const execFileAsync = promisify(execFile)

const MIX_TIMEOUT_MS = 5 * 60_000

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Mix VO over an assembled video.
 *
 * @param videoPath   Path to the assembled MP4 (output of assembleShortFromBrief)
 * @param voFiles     VO segment files in playback order
 * @param workDir     Working directory for temp files
 * @param log         Render-scoped logger
 * @returns           Path to the mixed MP4 (different file from videoPath)
 */
export async function mixVoiceover(opts: {
  videoPath: string
  voFiles: VOFile[]
  workDir: string
  log: (msg: string) => void
}): Promise<string> {
  const { videoPath, voFiles, workDir, log } = opts

  if (voFiles.length === 0) return videoPath

  const voCombinedPath = join(workDir, 'vo_combined.mp3')
  const mixedPath = join(workDir, 'output_mixed.mp4')

  // ── Step 1: Combine VO segments ───────────────────────────────────────────
  if (voFiles.length === 1) {
    await copyFile(voFiles[0]!.audioPath, voCombinedPath)
  } else {
    // Write ffmpeg concat list — absolute paths, no unsafe char issues
    const concatList = voFiles.map((f) => `file '${f.audioPath}'`).join('\n')
    const listPath = join(workDir, 'vo_list.txt')
    await writeFile(listPath, concatList)

    log(`concatenating ${voFiles.length} VO segments`)
    await execFileAsync(
      'ffmpeg',
      ['-f', 'concat', '-safe', '0', '-i', listPath, '-ar', '44100', '-ac', '1', '-y', voCombinedPath],
      { timeout: 60_000 },
    )
  }

  // ── Step 2: Mix VO over video ─────────────────────────────────────────────
  //
  // Filter graph:
  //   [1:a]apad → extend VO with silence to match video length.
  //     Critical: sidechaincompress terminates its output when the sidechain
  //     stream ends. Without apad, audio past the last VO segment is completely
  //     silent because the compressor stops producing output as soon as [vo_sc]
  //     exhausts. With silence-padded sidechain the threshold (0.02) is never
  //     exceeded in the tail, so source audio passes through uncompressed.
  //   [vo_padded]asplit → sends padded VO to mix bus [vo_mix] and sidechain [vo_sc]
  //   [0:a][vo_sc]sidechaincompress → compresses source audio when VO exceeds threshold
  //     threshold=0.02  (~-34dBFS): compression kicks in when VO is audible
  //     ratio=10        : heavy compression — net source attenuation ≈ -18dB in VO regions
  //     attack=5ms / release=200ms: fast onset, gentle release (avoids pumping)
  //   [src_ducked][vo_mix]amix → combine compressed source + VO at 0dB
  //     normalize=0: no auto-level normalisation from amix itself
  //     duration=first: output length = video length (VO may be shorter)
  //   loudnorm: two-pass EBU R128 normalisation to -16 LUFS, -1.5dBTP, LRA≤11
  //
  // Video stream is copied — no re-encode.

  log('mixing VO with sidechain ducking and -16 LUFS normalization')

  const filterComplex = [
    '[1:a]apad[vo_padded]',
    '[vo_padded]asplit[vo_mix][vo_sc]',
    '[0:a][vo_sc]sidechaincompress=threshold=0.02:ratio=10:attack=5:release=200[src_ducked]',
    '[src_ducked][vo_mix]amix=inputs=2:duration=first:normalize=0[mixed]',
    '[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[normed]',
  ].join(';')

  const args = [
    '-i', videoPath,
    '-i', voCombinedPath,
    '-filter_complex', filterComplex,
    '-map', '0:v',
    '-map', '[normed]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    '-y',
    mixedPath,
  ]

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
