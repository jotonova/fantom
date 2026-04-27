'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../../src/lib/api-client'
import { Avatar, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Spinner } from '@fantom/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

type VoiceStatus = 'pending' | 'training' | 'processing' | 'ready' | 'failed'

interface VoiceClone {
  id: string
  name: string
  description: string | null
  provider: string
  providerVoiceId: string | null
  isDefaultForKind: string | null
  sourceAssetId: string | null
  status: VoiceStatus
  isPersonal: boolean
  ownerUserId: string | null
  cloneFailedReason: string | null
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

interface AssetUploadUrlResponse {
  uploadUrl: string
  key: string
}

interface AssetRegisterResponse {
  id: string
}

interface CloneStatusResponse {
  id: string
  status: VoiceStatus
  cloneFailedReason: string | null
  providerVoiceId: string | null
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: VoiceStatus }) {
  const variant =
    status === 'ready' ? 'success' :
    status === 'failed' ? 'danger' :
    status === 'training' || status === 'processing' ? 'warning' : 'neutral'
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
          <audio controls autoPlay src={result.publicUrl} className="w-full">
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

// ── Voice Clone Wizard ────────────────────────────────────────────────────────

type WizardStep = 'upload' | 'name' | 'training' | 'done'

function CloneVoiceWizard({ onClose, onReady }: { onClose: () => void; onReady: (voice: VoiceClone) => void }) {
  const [step, setStep] = useState<WizardStep>('upload')
  const [audioAssetId, setAudioAssetId] = useState<string | null>(null)
  const [audioFilename, setAudioFilename] = useState<string>('')
  const [name, setName] = useState('')
  const [cloneId, setCloneId] = useState<string | null>(null)
  const [cloneStatus, setCloneStatus] = useState<VoiceStatus | null>(null)
  const [failedReason, setFailedReason] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Clean up polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  async function handleAudioUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const { uploadUrl, key } = await apiFetch<AssetUploadUrlResponse>('/assets/upload-url', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, mimeType: file.type, kind: 'audio' }),
      })
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', uploadUrl)
        xhr.setRequestHeader('Content-Type', file.type)
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`)))
        xhr.onerror = () => reject(new Error('Network error'))
        xhr.send(file)
      })
      const asset = await apiFetch<AssetRegisterResponse>('/assets', {
        method: 'POST',
        body: JSON.stringify({
          key,
          filename: file.name,
          kind: 'audio',
          mimeType: file.type,
          sizeBytes: file.size,
        }),
      })
      setAudioAssetId(asset.id)
      setAudioFilename(file.name)
      setName(file.name.replace(/\.[^.]+$/, ''))
      setStep('name')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleStartTraining() {
    if (!audioAssetId || !name.trim()) return
    setStarting(true)
    setError(null)
    try {
      const clone = await apiFetch<VoiceClone>('/voices/clones/start', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), trainingAudioAssetId: audioAssetId }),
      })
      setCloneId(clone.id)
      setCloneStatus('training')
      setStep('training')

      // Poll for status every 5 seconds
      pollRef.current = setInterval(async () => {
        try {
          const status = await apiFetch<CloneStatusResponse>(`/voices/clones/${clone.id}/status`)
          setCloneStatus(status.status)
          if (status.status === 'ready') {
            if (pollRef.current) clearInterval(pollRef.current)
            setStep('done')
            // Reload the full voice record to pass back
            const full = await apiFetch<VoiceClone>(`/voices/${clone.id}`)
              .catch(() => ({ ...clone, status: 'ready' as VoiceStatus, providerVoiceId: status.providerVoiceId }))
            onReady(full as VoiceClone)
          } else if (status.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current)
            setFailedReason(status.cloneFailedReason)
          }
        } catch {
          // polling errors are non-fatal
        }
      }, 5000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start training')
    } finally {
      setStarting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-md rounded-fantom border border-fantom-steel-border bg-fantom-steel-lighter shadow-2xl">
        <div className="flex items-center justify-between border-b border-fantom-steel-border px-5 py-4">
          <h2 className="font-semibold text-fantom-text">Clone your voice</h2>
          <button onClick={onClose} className="text-fantom-text-muted hover:text-fantom-text" aria-label="Close">✕</button>
        </div>

        <div className="px-5 py-5">
          {/* Step: upload */}
          {step === 'upload' && (
            <div className="space-y-4">
              <p className="text-sm text-fantom-text-muted">
                Upload a clear audio sample (30–120 seconds). MP3, WAV, or M4A. Quiet background, no music.
              </p>
              <Button onClick={() => fileRef.current?.click()} disabled={uploading} className="w-full">
                {uploading ? <><Spinner size="sm" /><span className="ml-2">Uploading…</span></> : 'Choose audio file'}
              </Button>
              <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={handleAudioUpload} />
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
          )}

          {/* Step: name */}
          {step === 'name' && (
            <div className="space-y-4">
              <p className="text-sm text-fantom-text-muted">
                Audio uploaded: <span className="text-fantom-text">{audioFilename}</span>
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="clone-name">Voice name</Label>
                <Input
                  id="clone-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Voice Clone"
                  autoFocus
                />
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setStep('upload')}>Back</Button>
                <Button onClick={handleStartTraining} disabled={starting || !name.trim()} className="flex-1">
                  {starting ? <><Spinner size="sm" /><span className="ml-2">Starting…</span></> : 'Start training'}
                </Button>
              </div>
            </div>
          )}

          {/* Step: training */}
          {step === 'training' && (
            <div className="space-y-4 text-center">
              {cloneStatus !== 'failed' ? (
                <>
                  <Spinner size="lg" />
                  <p className="text-fantom-text">Training your voice clone…</p>
                  <p className="text-sm text-fantom-text-muted">
                    Status: <span className="capitalize">{cloneStatus}</span> — this takes 30–120 seconds.
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium text-red-400">Training failed</p>
                  {failedReason && (
                    <p className="text-xs text-fantom-text-muted">{failedReason}</p>
                  )}
                  <Button onClick={onClose}>Close</Button>
                </>
              )}
            </div>
          )}

          {/* Step: done */}
          {step === 'done' && (
            <div className="space-y-4 text-center">
              <p className="text-2xl">🎉</p>
              <p className="font-medium text-fantom-text">Voice clone ready!</p>
              <p className="text-sm text-fantom-text-muted">
                <strong>{name}</strong> is ready for synthesis and rendering.
              </p>
              <Button onClick={onClose} className="w-full">Done</Button>
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
  const [showCloneWizard, setShowCloneWizard] = useState(false)
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

  const defaultVoices = voices.filter((v) => !v.isPersonal)
  const personalVoices = voices.filter((v) => v.isPersonal)

  function renderVoiceCard(voice: VoiceClone) {
    return (
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
              {voice.isPersonal && <Badge variant="neutral">personal</Badge>}
              {voice.sourceAssetId && !voice.isPersonal && <Badge variant="neutral">cloned</Badge>}
            </div>
            {voice.description && (
              <p className="mt-0.5 text-sm text-fantom-text-muted">{voice.description}</p>
            )}
            {voice.status === 'failed' && voice.cloneFailedReason && (
              <p className="mt-0.5 text-xs text-red-400">{voice.cloneFailedReason}</p>
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
    )
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-fantom-text">Voice Vault</h1>
          <p className="mt-1 text-sm text-fantom-text-muted">
            The voices Fantom uses for narration, market updates, and virtual tours
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setShowCloneWizard(true)}>Clone my voice</Button>
          <Button onClick={() => setShowPickModal(true)}>Add a voice</Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {/* Default voices */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-fantom-text-muted uppercase tracking-wide">
              Default Voices
            </h2>
            {defaultVoices.length === 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>No voices yet</CardTitle>
                  <CardDescription>
                    Add a default voice from ElevenLabs to get started.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button onClick={() => setShowPickModal(true)}>Add a voice</Button>
                </CardContent>
              </Card>
            ) : (
              defaultVoices.map(renderVoiceCard)
            )}
          </section>

          {/* Personal voice clones */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-fantom-text-muted uppercase tracking-wide">
                Personal Voice Clones
              </h2>
              <Button size="sm" variant="ghost" onClick={() => setShowCloneWizard(true)}>
                + Clone my voice
              </Button>
            </div>
            {personalVoices.length === 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>No personal clones</CardTitle>
                  <CardDescription>
                    Clone your own voice from an audio sample. Training takes 30–120 seconds.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button onClick={() => setShowCloneWizard(true)}>Clone my voice</Button>
                </CardContent>
              </Card>
            ) : (
              personalVoices.map(renderVoiceCard)
            )}
          </section>
        </>
      )}

      {showPickModal && (
        <PickDefaultVoiceModal
          onClose={() => setShowPickModal(false)}
          onAdd={handleAdd}
        />
      )}

      {showCloneWizard && (
        <CloneVoiceWizard
          onClose={() => setShowCloneWizard(false)}
          onReady={(voice) => {
            handleAdd(voice)
            setShowCloneWizard(false)
          }}
        />
      )}
    </div>
  )
}
