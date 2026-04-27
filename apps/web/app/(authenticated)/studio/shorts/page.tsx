'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '../../../../src/lib/api-client'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Spinner,
} from '@fantom/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BrandKit {
  id: string
  name: string
  slug: string | null
  isDefault: boolean
  logoUrl: string | null
  primaryColor: string | null
}

interface VoiceClone {
  id: string
  name: string
  status: string
  providerVoiceId: string | null
}

interface Asset {
  id: string
  originalFilename: string
  publicUrl: string
  kind: string
}

type ShortVibe = 'excited_reveal' | 'calm_walkthrough' | 'educational_breakdown'
type MusicVibe = 'upbeat' | 'calm' | 'dramatic' | 'inspirational' | 'none'

interface GenerateScriptResult {
  script: string
  suggestedCaptions: string[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const VIBE_OPTIONS: { value: ShortVibe; label: string; description: string }[] = [
  { value: 'excited_reveal', label: 'Excited Reveal', description: 'High-energy, punchy, hooks immediately' },
  { value: 'calm_walkthrough', label: 'Calm Walkthrough', description: 'Measured, conversational, builds trust' },
  { value: 'educational_breakdown', label: 'Educational', description: 'Clear, authoritative, teaches something' },
]

const MUSIC_VIBE_OPTIONS: { value: MusicVibe; label: string }[] = [
  { value: 'upbeat', label: 'Upbeat' },
  { value: 'calm', label: 'Calm' },
  { value: 'dramatic', label: 'Dramatic' },
  { value: 'inspirational', label: 'Inspirational' },
  { value: 'none', label: 'No Music' },
]

// ── Photo drag-drop zone ──────────────────────────────────────────────────────

function PhotoDropZone({
  photos,
  onAdd,
  onRemove,
  uploading,
}: {
  photos: Asset[]
  onAdd: (files: FileList) => void
  onRemove: (id: string) => void
  uploading: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) onAdd(e.dataTransfer.files)
  }

  return (
    <div className="space-y-3">
      <div
        className={`relative flex min-h-[120px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors ${
          dragOver
            ? 'border-fantom-blue bg-fantom-blue/5'
            : 'border-fantom-steel-border hover:border-fantom-blue/50'
        }`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
        aria-label="Upload photos"
      >
        {uploading ? (
          <Spinner size="sm" />
        ) : (
          <>
            <p className="text-sm text-fantom-text-muted">Drop photos here or click to browse</p>
            <p className="mt-1 text-xs text-fantom-text-muted/60">JPEG, PNG, WebP — max 100 MB each</p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={(e) => e.target.files && onAdd(e.target.files)}
        />
      </div>

      {photos.length > 0 && (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
          {photos.map((photo, i) => (
            <div key={photo.id} className="group relative aspect-square overflow-hidden rounded-md">
              <img
                src={photo.publicUrl}
                alt={photo.originalFilename}
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(photo.id) }}
                  className="rounded-full bg-red-500/90 px-2 py-0.5 text-xs text-white"
                  aria-label={`Remove photo ${i + 1}`}
                >
                  Remove
                </button>
              </div>
              <span className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5 text-center text-[10px] text-white">
                {i + 1}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Caption selector ──────────────────────────────────────────────────────────

function CaptionSelector({
  captions,
  selected,
  onSelect,
  custom,
  onCustomChange,
}: {
  captions: string[]
  selected: string
  onSelect: (c: string) => void
  custom: string
  onCustomChange: (v: string) => void
}) {
  const [useCustom, setUseCustom] = useState(false)

  return (
    <div className="space-y-2">
      {captions.map((c, i) => (
        <button
          key={i}
          onClick={() => { setUseCustom(false); onSelect(c) }}
          className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
            !useCustom && selected === c
              ? 'border-fantom-blue bg-fantom-blue/10 text-fantom-text'
              : 'border-fantom-steel-border text-fantom-text-muted hover:border-fantom-blue/50'
          }`}
        >
          {c}
        </button>
      ))}
      <div className="space-y-1">
        <Label className="text-xs text-fantom-text-muted">Or write your own</Label>
        <Input
          value={custom}
          onChange={(e) => {
            setUseCustom(true)
            onCustomChange(e.target.value)
            onSelect(e.target.value)
          }}
          onFocus={() => { if (custom) setUseCustom(true) }}
          placeholder="Custom caption (≤12 words)..."
          className={`text-sm ${useCustom && custom ? 'border-fantom-blue' : ''}`}
        />
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ShortsCreatePage() {
  const router = useRouter()

  // Data
  const [brandKits, setBrandKits] = useState<BrandKit[]>([])
  const [voices, setVoices] = useState<VoiceClone[]>([])

  // Form state
  const [photos, setPhotos] = useState<Asset[]>([])
  const [vibe, setVibe] = useState<ShortVibe>('calm_walkthrough')
  const [brandKitId, setBrandKitId] = useState<string>('')
  const [voiceCloneId, setVoiceCloneId] = useState<string>('')
  const [musicVibe, setMusicVibe] = useState<MusicVibe>('calm')
  const [targetDuration, setTargetDuration] = useState(60)
  const [script, setScript] = useState('')
  const [hint, setHint] = useState('')
  const [captionText, setCaptionText] = useState('')
  const [customCaption, setCustomCaption] = useState('')
  const [suggestedCaptions, setSuggestedCaptions] = useState<string[]>([])

  // UI state
  const [uploading, setUploading] = useState(false)
  const [generatingScript, setGeneratingScript] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load brand kits + voices on mount
  useEffect(() => {
    void apiFetch<{ brandKits: BrandKit[] }>('/brand-kits').then((r) => {
      setBrandKits(r.brandKits ?? [])
      const def = r.brandKits?.find((k) => k.isDefault)
      if (def) setBrandKitId(def.id)
    }).catch(() => {})

    void apiFetch<{ voiceClones: VoiceClone[] }>('/voices').then((r) => {
      const ready = (r.voiceClones ?? []).filter((v) => v.status === 'ready')
      setVoices(ready)
    }).catch(() => {})
  }, [])

  // ── Photo upload ────────────────────────────────────────────────────────────

  const handlePhotoAdd = useCallback(async (files: FileList) => {
    setUploading(true)
    setError(null)
    const added: Asset[] = []

    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      try {
        // 1. Get presigned upload URL
        const { uploadUrl, key } = await apiFetch<{ uploadUrl: string; key: string }>(
          '/assets/upload-url',
          {
            method: 'POST',
            body: JSON.stringify({ filename: file.name, mimeType: file.type, kind: 'image' }),
          },
        )

        // 2. PUT to R2
        await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })

        // 3. Register in DB
        const asset = await apiFetch<Asset>('/assets', {
          method: 'POST',
          body: JSON.stringify({
            key,
            filename: file.name,
            kind: 'image',
            mimeType: file.type,
            sizeBytes: file.size,
          }),
        })

        added.push(asset)
      } catch (err) {
        setError(`Upload failed for ${file.name}: ${err instanceof Error ? err.message : 'Unknown error'}`)
      }
    }

    setPhotos((prev) => [...prev, ...added])
    setUploading(false)
  }, [])

  const handlePhotoRemove = useCallback((id: string) => {
    setPhotos((prev) => prev.filter((p) => p.id !== id))
  }, [])

  // ── Script generation ───────────────────────────────────────────────────────

  async function handleGenerateScript() {
    if (photos.length === 0) {
      setError('Add at least one photo before generating a script')
      return
    }

    const selectedKit = brandKits.find((k) => k.id === brandKitId)
    if (!selectedKit) {
      setError('Select a brand kit before generating a script')
      return
    }

    setGeneratingScript(true)
    setError(null)
    try {
      const result = await apiFetch<GenerateScriptResult>('/shorts/generate-script', {
        method: 'POST',
        body: JSON.stringify({
          vibe,
          brandKitName: selectedKit.name,
          photoCount: photos.length,
          targetDurationSeconds: targetDuration,
          hint: hint.trim() || undefined,
        }),
      })
      setScript(result.script)
      setSuggestedCaptions(result.suggestedCaptions)
      if (result.suggestedCaptions[0]) setCaptionText(result.suggestedCaptions[0])
    } catch (err) {
      setError(`Script generation failed: ${err instanceof Error ? err.message : 'Try again'}`)
    } finally {
      setGeneratingScript(false)
    }
  }

  // ── Submit ──────────────────────────────────────────────────────────────────

  async function handleSubmit() {
    if (photos.length === 0) { setError('Add at least one photo'); return }
    if (!script.trim()) { setError('Generate or write a script first'); return }

    setSubmitting(true)
    setError(null)
    try {
      const result = await apiFetch<{ id: string }>('/shorts', {
        method: 'POST',
        body: JSON.stringify({
          photoAssetIds: photos.map((p) => p.id),
          vibe,
          script: script.trim(),
          scriptSource: 'custom',
          captionText: captionText.trim() || undefined,
          captionSource: customCaption && captionText === customCaption ? 'custom' : 'ai_generated',
          brandKitId: brandKitId || undefined,
          voiceCloneId: voiceCloneId || undefined,
          musicVibe,
          targetDurationSeconds: targetDuration,
        }),
      })
      router.push(`/studio/shorts/${result.id}`)
    } catch (err) {
      setError(`Failed to create short: ${err instanceof Error ? err.message : 'Try again'}`)
      setSubmitting(false)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-fantom-text">Create Short</h1>
        <p className="mt-1 text-sm text-fantom-text-muted">
          Vertical 9:16 video · 1080 × 1920 · up to 2 minutes
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* ── Photos ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Photos
            {photos.length > 0 && (
              <Badge variant="neutral" className="ml-2">{photos.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <PhotoDropZone
            photos={photos}
            onAdd={handlePhotoAdd}
            onRemove={handlePhotoRemove}
            uploading={uploading}
          />
        </CardContent>
      </Card>

      {/* ── Brand + Voice + Vibe ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Brand & Voice</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="brand-kit">Brand Kit</Label>
              <select
                id="brand-kit"
                value={brandKitId}
                onChange={(e) => setBrandKitId(e.target.value)}
                className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue"
              >
                <option value="">No brand kit</option>
                {brandKits.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}{k.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="voice">Voice</Label>
              <select
                id="voice"
                value={voiceCloneId}
                onChange={(e) => setVoiceCloneId(e.target.value)}
                className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue"
              >
                <option value="">Default voice</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Vibe</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              {VIBE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setVibe(opt.value)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    vibe === opt.value
                      ? 'border-fantom-blue bg-fantom-blue/10'
                      : 'border-fantom-steel-border hover:border-fantom-blue/50'
                  }`}
                >
                  <p className="text-sm font-medium text-fantom-text">{opt.label}</p>
                  <p className="mt-0.5 text-xs text-fantom-text-muted">{opt.description}</p>
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Duration + Music ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Duration & Music</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="duration">
              Target Duration: <span className="font-semibold text-fantom-text">{targetDuration}s</span>
            </Label>
            <input
              id="duration"
              type="range"
              min={15}
              max={120}
              step={5}
              value={targetDuration}
              onChange={(e) => setTargetDuration(Number(e.target.value))}
              className="w-full accent-fantom-blue"
            />
            <div className="flex justify-between text-xs text-fantom-text-muted">
              <span>15s</span>
              <span>120s</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Music Vibe</Label>
            <div className="flex flex-wrap gap-2">
              {MUSIC_VIBE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setMusicVibe(opt.value)}
                  className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                    musicVibe === opt.value
                      ? 'border-fantom-blue bg-fantom-blue/10 text-fantom-text'
                      : 'border-fantom-steel-border text-fantom-text-muted hover:border-fantom-blue/50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Script ──────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Script</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="hint">Director hint (optional)</Label>
            <Input
              id="hint"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="e.g. 'Focus on the backyard and pool views'"
            />
          </div>

          <Button
            variant="secondary"
            onClick={handleGenerateScript}
            disabled={generatingScript || photos.length === 0}
            className="w-full"
          >
            {generatingScript ? (
              <span className="flex items-center gap-2">
                <Spinner size="sm" /> Generating script...
              </span>
            ) : (
              'Generate Script with AI'
            )}
          </Button>

          <div className="space-y-1.5">
            <Label htmlFor="script">Voiceover script</Label>
            <textarea
              id="script"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder="Your voiceover script will appear here — or type your own..."
              rows={6}
              className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/50 focus:outline-none focus:ring-2 focus:ring-fantom-blue"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Captions ────────────────────────────────────────────────────────── */}
      {(suggestedCaptions.length > 0 || script) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Caption</CardTitle>
          </CardHeader>
          <CardContent>
            {suggestedCaptions.length > 0 ? (
              <CaptionSelector
                captions={suggestedCaptions}
                selected={captionText}
                onSelect={setCaptionText}
                custom={customCaption}
                onCustomChange={setCustomCaption}
              />
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="caption">Caption text</Label>
                <Input
                  id="caption"
                  value={captionText}
                  onChange={(e) => setCaptionText(e.target.value)}
                  placeholder="Short overlay text (≤12 words)..."
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Submit ──────────────────────────────────────────────────────────── */}
      <div className="flex justify-end gap-3 pb-8">
        <Button variant="secondary" onClick={() => router.back()} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={submitting || photos.length === 0 || !script.trim()}
        >
          {submitting ? (
            <span className="flex items-center gap-2">
              <Spinner size="sm" /> Creating...
            </span>
          ) : (
            'Create & Render'
          )}
        </Button>
      </div>
    </div>
  )
}
