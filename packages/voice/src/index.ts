const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1'

function apiKey(): string {
  return process.env['ELEVENLABS_API_KEY'] ?? ''
}

function xiHeaders(): Record<string, string> {
  return { 'xi-api-key': apiKey() }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VoiceListItem {
  id: string
  name: string
  category: string
  description: string
  previewUrl: string
}

export interface VoiceDetails extends VoiceListItem {
  labels: Record<string, string>
  settings: { stability: number; similarityBoost: number } | null
}

// ── Raw ElevenLabs API shapes ──────────────────────────────────────────────────

interface ElevenLabsVoice {
  voice_id: string
  name: string
  category: string
  description: string
  preview_url: string
  labels: Record<string, string>
  settings: { stability: number; similarity_boost: number } | null
}

interface ElevenLabsVoiceList {
  voices: ElevenLabsVoice[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapVoice(v: ElevenLabsVoice): VoiceDetails {
  return {
    id: v.voice_id,
    name: v.name,
    category: v.category ?? '',
    description: v.description ?? '',
    previewUrl: v.preview_url ?? '',
    labels: v.labels ?? {},
    settings: v.settings
      ? { stability: v.settings.stability, similarityBoost: v.settings.similarity_boost }
      : null,
  }
}

// ── API ───────────────────────────────────────────────────────────────────────

export async function listVoices(): Promise<VoiceListItem[]> {
  const res = await fetch(`${ELEVENLABS_API_BASE}/voices`, {
    headers: xiHeaders(),
  })
  if (!res.ok) throw new Error(`ElevenLabs listVoices: ${res.status}`)
  const data = (await res.json()) as ElevenLabsVoiceList
  return data.voices.map(mapVoice)
}

export async function getVoice(voiceId: string): Promise<VoiceDetails> {
  const res = await fetch(`${ELEVENLABS_API_BASE}/voices/${voiceId}`, {
    headers: xiHeaders(),
  })
  if (!res.ok) throw new Error(`ElevenLabs getVoice: ${res.status}`)
  const v = (await res.json()) as ElevenLabsVoice
  return mapVoice(v)
}

export async function cloneVoice(opts: {
  name: string
  description?: string
  audioFileBuffer: Buffer
  filename: string
}): Promise<{ providerVoiceId: string }> {
  const form = new FormData()
  form.append('name', opts.name)
  if (opts.description) form.append('description', opts.description)
  form.append('files', new Blob([opts.audioFileBuffer]), opts.filename)

  const res = await fetch(`${ELEVENLABS_API_BASE}/voices/add`, {
    method: 'POST',
    headers: xiHeaders(),
    body: form,
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`ElevenLabs cloneVoice: ${res.status} ${body}`)
  }
  const data = (await res.json()) as { voice_id: string }
  return { providerVoiceId: data.voice_id }
}

export async function synthesize(opts: {
  text: string
  voiceId: string
  modelId?: string
}): Promise<Buffer> {
  const modelId = opts.modelId ?? 'eleven_multilingual_v2'
  const res = await fetch(`${ELEVENLABS_API_BASE}/text-to-speech/${opts.voiceId}`, {
    method: 'POST',
    headers: { ...xiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: opts.text,
      model_id: modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`ElevenLabs synthesize: ${res.status} ${body}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

export async function deleteVoice(voiceId: string): Promise<void> {
  const res = await fetch(`${ELEVENLABS_API_BASE}/voices/${voiceId}`, {
    method: 'DELETE',
    headers: xiHeaders(),
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`ElevenLabs deleteVoice: ${res.status}`)
  }
}
