import { createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import https from 'https'
import http from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ── Types ─────────────────────────────────────────────────────────────────────

export type MusicVibe = 'upbeat' | 'calm' | 'dramatic' | 'inspirational' | 'none'

export interface MusicResult {
  /** Absolute path to a local temp file containing the music audio */
  filePath: string
  /** Provider that served this track */
  provider: string
}

export interface MusicProvider {
  readonly name: string
  fetchMusic(vibe: MusicVibe, durationSeconds: number): Promise<MusicResult>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function downloadToTmp(url: string, ext: string = 'mp3'): Promise<string> {
  return new Promise((resolve, reject) => {
    const dest = join(tmpdir(), `fantom-music-${randomUUID()}.${ext}`)
    const file = createWriteStream(dest)
    const proto = url.startsWith('https') ? https : http

    proto
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`))
          return
        }
        pipeline(res as unknown as Readable, file)
          .then(() => resolve(dest))
          .catch(reject)
      })
      .on('error', reject)
  })
}

// ── ElevenLabs Music Provider ─────────────────────────────────────────────────

const ELEVENLABS_VIBE_PROMPTS: Record<MusicVibe, string> = {
  upbeat: 'upbeat energetic background music, positive mood, modern pop',
  calm: 'calm relaxing background music, soft piano, ambient',
  dramatic: 'cinematic dramatic music, tension building, orchestral',
  inspirational: 'inspirational uplifting music, motivational, feel-good',
  none: 'soft neutral background ambience, very subtle',
}

export class ElevenLabsMusicProvider implements MusicProvider {
  readonly name = 'elevenlabs'

  async fetchMusic(vibe: MusicVibe, durationSeconds: number): Promise<MusicResult> {
    const apiKey = process.env['ELEVENLABS_API_KEY']
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set')

    const prompt = ELEVENLABS_VIBE_PROMPTS[vibe]
    // ElevenLabs sound-generation endpoint accepts duration_seconds (max 22s per call).
    // For longer music we request 22s and loop in ffmpeg.
    const requestDuration = Math.min(durationSeconds, 22)

    const response = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: prompt,
        duration_seconds: requestDuration,
        prompt_influence: 0.3,
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`ElevenLabs sound-generation failed: HTTP ${response.status} — ${body}`)
    }

    const dest = join(tmpdir(), `fantom-music-${randomUUID()}.mp3`)
    const fileStream = createWriteStream(dest)
    const reader = response.body
    if (!reader) throw new Error('ElevenLabs response body is null')

    // Stream response body to file
    await pipeline(
      Readable.fromWeb(reader as Parameters<typeof Readable.fromWeb>[0]),
      fileStream,
    )

    return { filePath: dest, provider: this.name }
  }
}

// ── Pixabay Music Provider ────────────────────────────────────────────────────

interface PixabayHit {
  audio?: { mp3?: string } | null
  url?: string
}

interface PixabayResponse {
  hits?: PixabayHit[]
}

const PIXABAY_VIBE_TAGS: Record<MusicVibe, string> = {
  upbeat: 'upbeat',
  calm: 'calm',
  dramatic: 'dramatic',
  inspirational: 'inspirational',
  none: 'ambient',
}

export class PixabayMusicProvider implements MusicProvider {
  readonly name = 'pixabay'

  async fetchMusic(vibe: MusicVibe, _durationSeconds: number): Promise<MusicResult> {
    const apiKey = process.env['PIXABAY_API_KEY']
    if (!apiKey) throw new Error('PIXABAY_API_KEY is not set')

    const tag = PIXABAY_VIBE_TAGS[vibe]
    const apiUrl = `https://pixabay.com/api/music/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(tag)}&per_page=5`

    const res = await fetch(apiUrl)
    if (!res.ok) {
      throw new Error(`Pixabay API failed: HTTP ${res.status}`)
    }

    const data = (await res.json()) as PixabayResponse
    const hits = data.hits ?? []

    // Find first hit that has an mp3 URL
    let mp3Url: string | null = null
    for (const hit of hits) {
      const url = hit.audio?.mp3 ?? hit.url
      if (typeof url === 'string' && url.endsWith('.mp3')) {
        mp3Url = url
        break
      }
    }

    if (!mp3Url) throw new Error(`No Pixabay tracks found for vibe: ${vibe}`)

    const dest = await downloadToTmp(mp3Url, 'mp3')
    return { filePath: dest, provider: this.name }
  }
}

// ── Composite fetcher with fallback ──────────────────────────────────────────

const elevenLabsProvider = new ElevenLabsMusicProvider()
const pixabayProvider = new PixabayMusicProvider()

/**
 * Fetch background music for a given vibe and duration.
 * Tries ElevenLabs first, falls back to Pixabay.
 * Returns null if both fail (caller should proceed without music).
 */
export async function fetchMusic(
  vibe: MusicVibe,
  durationSeconds: number,
  log: (msg: string) => void,
): Promise<MusicResult | null> {
  if (vibe === 'none') return null

  try {
    const result = await elevenLabsProvider.fetchMusic(vibe, durationSeconds)
    log(`Music fetched from ElevenLabs (${vibe})`)
    return result
  } catch (err) {
    log(`ElevenLabs music failed (${String(err)}), trying Pixabay fallback`)
  }

  try {
    const result = await pixabayProvider.fetchMusic(vibe, durationSeconds)
    log(`Music fetched from Pixabay (${vibe})`)
    return result
  } catch (err) {
    log(`Pixabay music fallback also failed (${String(err)}), proceeding without music`)
    return null
  }
}
