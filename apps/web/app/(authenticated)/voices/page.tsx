'use client'

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../../src/lib/api-client'
import { Avatar, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Spinner } from '@fantom/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

type VoiceStatus = 'pending' | 'processing' | 'ready' | 'failed'

interface VoiceClone {
  id: string
  name: string
  description: string | null
  provider: string
  providerVoiceId: string | null
  isDefaultForKind: string | null
  sourceAssetId: string | null
  status: VoiceStatus
  createdAt: string
}

interface ElevenLabsVoice {
  id: string
  name: string
  category: string
  description: string
  previewUrl: string
}

interface SynthesizedAsset {
  id: string
  publicUrl: string
  originalFilename: string
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: VoiceStatus }) {
  const variant =
    status === 'ready' ? 'success' : status === 'failed' ? 'danger' : 'warning'
  return <Badge variant={variant}>{status}</Badge>
}

// ── Synthesize panel ─────────────────────────────────────────────────────────

function SynthesizePanel({ voiceId, voiceName }: { voiceId: string; voiceName: string }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<SynthesizedAsset | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate() {
    if (!text.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const asset = await apiFetch<SynthesizedAsset>(`/voices/${voiceId}/synthesize`, {
        method: 'POST',
        body: JSON.stringify({ text: text.trim() }),
      })
      setResult(asset)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Synthesis failed')
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Test it
      </Button>
    )
  }

  return (
    <div className="mt-3 space-y-2 rounded-[6px] border border-fantom-steel-border bg-fantom-steel p-3">
      <Label htmlFor={`text-${voiceId}`}>Text to synthesize</Label>
      <textarea
        id={`text-${voiceId}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={5000}
        rows={3}
        placeholder="Hello from Fantom..."
        className="w-full resize-none rounded-fantom border border-fantom-steel-border bg-fantom-steel-lighter px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fantom-blue"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleGenerate} disabled={loading || !text.trim()}>
          {loading ? <Spinner size="sm" /> : 'Generate'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && (
        <div className="space-y-1">
          <p className="text-xs text-fantom-text-muted">
            Synthesized: <span className="text-fantom-text">{result.originalFilename}</span>
          </p>
          <audio controls src={result.publicUrl} className="w-full">
            <track kind="captions" />
          </audio>
        </div>
      )}
    </div>
  )
}

// ── Pick default voice modal ──────────────────────────────────────────────────

function PickDefaultVoiceModal({ onClose, onAdd }: { onClose: () => void; onAdd: (voice: VoiceClone) => void }) {
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [adopting, setAdopting] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<{ voices: ElevenLabsVoice[] }>('/voices/elevenlabs-defaults')
      .then((data) => setVoices(data.voices))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const filtered = voices.filter((v) =>
    v.name.toLowerCase().includes(search.toLowerCase()),
  )

  async function handleAdd(v: ElevenLabsVoice) {
    setAdopting(v.id)
    try {
      const created = await apiFetch<VoiceClone>(`/voices/from-elevenlabs/${v.id}`, {
        method: 'POST',
        body: JSON.stringify({ name: v.name, description: v.description }),
      })
      onAdd(created)
      onClose()
    } catch (err) {
      console.error(err)
    } finally {
      setAdopting(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-fantom border border-fantom-steel-border bg-fantom-steel-lighter shadow-2xl">
        <div className="flex items-center justify-between border-b border-fantom-steel-border px-5 py-4">
          <h2 className="font-semibold text-fantom-text">Pick a default voice</h2>
          <button
            onClick={onClose}
            className="text-fantom-text-muted hover:text-fantom-text"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-3">
          <Input
            placeholder="Search voices..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {loading ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-fantom-text-muted">No voices found.</p>
          ) : (
            <div className="space-y-2">
              {filtered.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center gap-3 rounded-[6px] border border-fantom-steel-border bg-fantom-steel p-3"
                >
                  <Avatar fallback={v.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-fantom-text">{v.name}</p>
                    {v.description && (
                      <p className="truncate text-xs text-fantom-text-muted">{v.description}</p>
                    )}
                    {v.previewUrl && (
                      <audio src={v.previewUrl} controls className="mt-1.5 h-7 w-full">
                        <track kind="captions" />
                      </audio>
                    )}
                  </div>
                  <Button
                    size="sm"
                    onClick={() => void handleAdd(v)}
                    disabled={adopting === v.id}
                  >
                    {adopting === v.id ? <Spinner size="sm" /> : 'Add'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function VoicesPage() {
  const [voices, setVoices] = useState<VoiceClone[]>([])
  const [loading, setLoading] = useState(true)
  const [showPickModal, setShowPickModal] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<{ voices: VoiceClone[] }>('/voices')
      .then((data) => setVoices(data.voices))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const handleAdd = useCallback((voice: VoiceClone) => {
    setVoices((prev) => [...prev, voice])
  }, [])

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Remove "${name}" from your voice vault?`)) return
    setDeleting(id)
    try {
      await apiFetch(`/voices/${id}`, { method: 'DELETE' })
      setVoices((prev) => prev.filter((v) => v.id !== id))
    } catch (err) {
      console.error(err)
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-fantom-text">Voice Vault</h1>
          <p className="mt-1 text-sm text-fantom-text-muted">
            The voices Fantom uses for narration, market updates, and virtual tours
          </p>
        </div>
        <Button onClick={() => setShowPickModal(true)}>Add a voice</Button>
      </div>

      {/* Voice list */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : voices.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No voices yet</CardTitle>
            <CardDescription>
              Add a default voice from ElevenLabs or clone your own from an audio sample.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => setShowPickModal(true)}>Add a voice</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {voices.map((voice) => (
            <Card key={voice.id} className="p-4">
              <div className="flex items-start gap-4">
                <Avatar fallback={voice.name} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-fantom-text">{voice.name}</span>
                    <StatusBadge status={voice.status} />
                    {voice.isDefaultForKind && (
                      <Badge variant="success">default: {voice.isDefaultForKind}</Badge>
                    )}
                    {voice.sourceAssetId && <Badge variant="neutral">cloned</Badge>}
                  </div>
                  {voice.description && (
                    <p className="mt-0.5 text-sm text-fantom-text-muted">{voice.description}</p>
                  )}
                  {voice.status === 'ready' && voice.providerVoiceId && (
                    <SynthesizePanel voiceId={voice.id} voiceName={voice.name} />
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleDelete(voice.id, voice.name)}
                  disabled={deleting === voice.id}
                  className="shrink-0"
                >
                  {deleting === voice.id ? <Spinner size="sm" /> : 'Remove'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Pick default voice modal */}
      {showPickModal && (
        <PickDefaultVoiceModal
          onClose={() => setShowPickModal(false)}
          onAdd={handleAdd}
        />
      )}
    </div>
  )
}
