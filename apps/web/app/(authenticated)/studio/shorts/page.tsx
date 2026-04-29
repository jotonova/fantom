'use client'

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
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

type AssetKind = 'image' | 'video' | 'audio' | 'document' | 'other'

interface Asset {
  id: string
  kind: AssetKind
  originalFilename: string
  mimeType: string
  sizeBytes: number
  publicUrl: string
  createdAt: string
}

interface BrandKit {
  id: string
  name: string
  isDefault: boolean
}

interface VoiceClone {
  id: string
  name: string
  status: string
  isPersonal: boolean
}

type ShortVibe = 'excited_reveal' | 'calm_walkthrough' | 'educational_breakdown'

interface ShortsJob {
  id: string
  status: 'draft' | 'rendering' | 'rendered' | 'failed' | 'approved' | 'scheduled' | 'posted'
  errorMessage: string | null
  outputVideoUrl: string | null
  captionText: string | null
  renderJobId: string | null
  assetRenderStatus: Record<string, { status: string }> | null
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ASSETS = 20
const WORDS_PER_MIN = 130

const VIBE_OPTIONS: { value: ShortVibe; label: string; description: string }[] = [
  { value: 'excited_reveal',        label: 'Excited Reveal',   description: 'High-energy, punchy, hooks immediately' },
  { value: 'calm_walkthrough',      label: 'Calm Walkthrough', description: 'Measured, conversational, builds trust' },
  { value: 'educational_breakdown', label: 'Educational',      description: 'Clear, authoritative, teaches something' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function wordCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function estimatedDuration(text: string) {
  return Math.round((wordCount(text) / WORDS_PER_MIN) * 60)
}

function formatBytes(n: number) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// ── Asset thumbnail ───────────────────────────────────────────────────────────

function AssetThumb({
  asset,
  selected,
  disabled,
  onClick,
}: {
  asset: Asset
  selected: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled && !selected}
      className={`group relative aspect-square overflow-hidden rounded-lg border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fantom-blue ${
        selected
          ? 'border-fantom-blue shadow-md shadow-fantom-blue/20'
          : disabled
          ? 'cursor-not-allowed border-fantom-steel-border opacity-40'
          : 'border-fantom-steel-border hover:border-fantom-blue/50'
      }`}
      title={asset.originalFilename}
      aria-pressed={selected}
    >
      {asset.kind === 'image' ? (
        <img
          src={asset.publicUrl}
          alt={asset.originalFilename}
          className="h-full w-full object-cover"
        />
      ) : asset.kind === 'video' ? (
        <div className="relative h-full w-full bg-fantom-steel">
          <video
            src={asset.publicUrl}
            className="h-full w-full object-cover"
            preload="metadata"
            muted
            playsInline
          />
          {/* Play icon overlay */}
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <svg className="h-6 w-6 text-white drop-shadow" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7L8 5z" />
            </svg>
          </div>
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-fantom-steel">
          <svg className="h-6 w-6 text-fantom-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
      )}

      {/* Selected check */}
      {selected && (
        <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-fantom-blue shadow">
          <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
      )}
    </button>
  )
}

// ── Render progress bar ───────────────────────────────────────────────────────

function RenderProgress({ renderJobId }: { renderJobId: string }) {
  const [pct, setPct] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      while (!cancelled) {
        try {
          const r = await apiFetch<{ progress: number; status: string }>(`/jobs/${renderJobId}`)
          if (!cancelled) setPct(r.progress ?? 0)
          if (r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled') break
        } catch { /* silent */ }
        await new Promise((res) => setTimeout(res, 3000))
      }
    }
    void poll()
    return () => { cancelled = true }
  }, [renderJobId])

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs text-fantom-text-muted">
        <span>Generating clips…</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-fantom-steel">
        <div className="h-full rounded-full bg-fantom-blue transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ShortsVPFPage() {
  const router = useRouter()

  // ── Library data ─────────────────────────────────────────────────────────────
  const [libraryAssets, setLibraryAssets] = useState<Asset[]>([])
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [brandKits, setBrandKits] = useState<BrandKit[]>([])
  const [voices, setVoices] = useState<VoiceClone[]>([])

  // ── Form state ────────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [vibe, setVibe] = useState<ShortVibe>('calm_walkthrough')
  const [brandKitId, setBrandKitId] = useState('')
  const [coBrandKitId, setCoBrandKitId] = useState('')
  const [complianceKitId, setComplianceKitId] = useState('')
  const [voiceCloneId, setVoiceCloneId] = useState('')
  const [generateVoiceover, setGenerateVoiceover] = useState(true)
  const [scriptMode, setScriptMode] = useState<'ai' | 'custom'>('ai')
  const [script, setScript] = useState('')
  const [captionMode, setCaptionMode] = useState<'ai' | 'custom' | 'none'>('ai')
  const [captionText, setCaptionText] = useState('')
  const [suggestedCaptions, setSuggestedCaptions] = useState<string[]>([])
  const [musicVibe, setMusicVibe] = useState('')
  const [targetDuration, setTargetDuration] = useState(30)
  const [sfxPrompt, setSfxPrompt] = useState('')

  // ── UI state ──────────────────────────────────────────────────────────────────
  const [generatingScript, setGeneratingScript] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<ShortsJob | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Load library + brand kits + voices ────────────────────────────────────────
  useEffect(() => {
    // Load all assets (image + video) for the library picker
    apiFetch<{ assets: Asset[] }>('/assets')
      .then((r) => {
        const pickable = (r.assets ?? []).filter(
          (a) => a.kind === 'image' || a.kind === 'video',
        )
        setLibraryAssets(pickable)
      })
      .catch(() => {})
      .finally(() => setLibraryLoading(false))

    apiFetch<{ brandKits: BrandKit[] }>('/brand-kits').then((r) => {
      const kits = r.brandKits ?? []
      setBrandKits(kits)
      const def = kits.find((k) => k.isDefault)
      if (def) setBrandKitId(def.id)
    }).catch(() => {})

    apiFetch<{ voices: VoiceClone[] }>('/voices').then((r) => {
      const ready = (r.voices ?? []).filter((v) => v.status === 'ready')
      setVoices(ready)
    }).catch(() => {})
  }, [])

  // ── Asset selection ───────────────────────────────────────────────────────────
  const toggleAsset = useCallback((id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= MAX_ASSETS) return prev
      return [...prev, id]
    })
  }, [])

  // ── Script generation ─────────────────────────────────────────────────────────
  async function handleGenerateScript() {
    if (selectedIds.length === 0) { setError('Select at least one asset first'); return }
    const kit = brandKits.find((k) => k.id === brandKitId) ?? brandKits[0]
    if (!kit) { setError('Select a primary brand kit first'); return }
    setGeneratingScript(true)
    setError(null)
    try {
      const result = await apiFetch<{ script: string; suggestedCaptions: string[] }>(
        '/shorts/generate-script',
        {
          method: 'POST',
          body: JSON.stringify({
            vibe,
            brandKitName: kit.name,
            photoCount: selectedIds.length,
            targetDurationSeconds: targetDuration,
          }),
        },
      )
      setScript(result.script)
      setSuggestedCaptions(result.suggestedCaptions ?? [])
      if (captionMode === 'ai' && result.suggestedCaptions?.[0]) {
        setCaptionText(result.suggestedCaptions[0])
      }
    } catch (err) {
      setError(`Script generation failed: ${err instanceof Error ? err.message : 'Try again'}`)
    } finally {
      setGeneratingScript(false)
    }
  }

  // ── Poll rendered job ─────────────────────────────────────────────────────────
  const pollJob = useCallback(async (id: string) => {
    try {
      const r = await apiFetch<ShortsJob>(`/shorts/${id}`)
      setJob(r)
      if (r.status === 'rendered' || r.status === 'failed') {
        if (pollRef.current) clearInterval(pollRef.current)
      }
    } catch { /* silent */ }
  }, [])

  // ── Submit ────────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (selectedIds.length === 0) { setError('Select at least one asset from your library'); return }
    if (!brandKitId) { setError('Primary brand kit is required'); return }
    if (generateVoiceover && !voiceCloneId) { setError('Select a voice clone (or uncheck Generate Voiceover)'); return }
    if (!script.trim()) { setError('Generate or write a script first'); return }

    setSubmitting(true)
    setError(null)

    try {
      // Step 1: Create draft
      // NOTE: coBrandKitId, complianceKitId, sfxPrompt are collected in the UI
      // but the POST /shorts validator doesn't yet accept them. Wired in Commit D.
      const draft = await apiFetch<{ id: string }>('/shorts', {
        method: 'POST',
        body: JSON.stringify({
          photoAssetIds: selectedIds,
          vibe,
          script: script.trim(),
          scriptSource: scriptMode === 'ai' ? 'ai_generated' : 'custom',
          captionText: captionMode !== 'none' ? captionText.trim() || undefined : undefined,
          captionSource: captionMode === 'ai' ? 'ai_generated' : captionMode === 'custom' ? 'custom' : undefined,
          brandKitId,
          voiceCloneId: generateVoiceover ? voiceCloneId : undefined,
          musicVibe: musicVibe.trim() || undefined,
          targetDurationSeconds: targetDuration,
        }),
      })

      // Step 2: Immediately fire render
      await apiFetch(`/shorts/${draft.id}/render`, { method: 'POST' })

      // Step 3: Load initial state + start polling
      const initial = await apiFetch<ShortsJob>(`/shorts/${draft.id}`)
      setJob(initial)

      pollRef.current = setInterval(() => void pollJob(draft.id), 5000)
    } catch (err) {
      setError(`Failed: ${err instanceof Error ? err.message : 'Try again'}`)
      setSubmitting(false)
    }
  }

  // Cleanup poll on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const sharedVoices = voices.filter((v) => !v.isPersonal)
  const personalVoices = voices.filter((v) => v.isPersonal)

  const wc = wordCount(script)
  const estSecs = estimatedDuration(script)

  // ── Result view ───────────────────────────────────────────────────────────────
  if (job) {
    const isRendering = job.status === 'rendering' || job.status === 'draft'
    const assetStatuses = Object.values(job.assetRenderStatus ?? {})
    const doneCt  = assetStatuses.filter((a) => a.status === 'done').length
    const totalCt = assetStatuses.length

    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/studio')}
            className="text-sm text-fantom-text-muted hover:text-fantom-text"
          >
            ← Studio
          </button>
          <span className="text-fantom-text-muted">/</span>
          <span className="text-sm text-fantom-text">Render</span>
        </div>

        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-fantom-text">
            {isRendering ? 'Generating…' : job.status === 'rendered' ? 'Your Short' : 'Render Failed'}
          </h1>
          <Badge
            variant={
              job.status === 'rendered' ? 'success' :
              job.status === 'failed'   ? 'danger'  :
              'warning'
            }
          >
            {job.status === 'rendered' ? 'Ready' : job.status === 'failed' ? 'Failed' : 'Rendering…'}
          </Badge>
        </div>

        {/* Progress */}
        {isRendering && (
          <Card>
            <CardContent className="space-y-4 pt-4">
              {job.renderJobId && <RenderProgress renderJobId={job.renderJobId} />}
              {totalCt > 0 && (
                <p className="text-xs text-fantom-text-muted">
                  Runway clips: {doneCt}/{totalCt} complete
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Video player */}
        {job.status === 'rendered' && job.outputVideoUrl && (
          <Card>
            <CardContent className="space-y-4 pt-4">
              <div className="flex justify-center">
                <video
                  src={job.outputVideoUrl}
                  controls
                  playsInline
                  className="max-h-[600px] max-w-[338px] w-full rounded-xl bg-black"
                  style={{ aspectRatio: '9/16' }}
                />
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-2 justify-center">
                <a
                  href={job.outputVideoUrl}
                  download
                  className="inline-flex items-center gap-1.5 rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-1.5 text-sm text-fantom-text hover:bg-fantom-steel-lighter transition-colors"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  Download
                </a>
                <button
                  onClick={() => void navigator.clipboard.writeText(job.outputVideoUrl!)}
                  className="inline-flex items-center gap-1.5 rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-1.5 text-sm text-fantom-text hover:bg-fantom-steel-lighter transition-colors"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
                  </svg>
                  Copy link
                </button>
                <Button variant="secondary" onClick={() => router.push(`/studio/shorts-legacy/${job.id}`)}>
                  Open detail view
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Failure */}
        {job.status === 'failed' && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {job.errorMessage ?? 'Render failed — check worker logs for details'}
          </div>
        )}

        {/* Start over */}
        <div className="flex justify-end">
          <Button
            variant="secondary"
            onClick={() => {
              if (pollRef.current) clearInterval(pollRef.current)
              setJob(null)
              setSubmitting(false)
            }}
          >
            {job.status === 'failed' ? 'Retry with edits' : 'Create another'}
          </Button>
        </div>
      </div>
    )
  }

  // ── Form view ─────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 text-sm text-fantom-text-muted mb-1">
          <button onClick={() => router.push('/studio')} className="hover:text-fantom-text">
            Studio
          </button>
          <span>/</span>
          <span className="text-fantom-text">Create a Short</span>
        </div>
        <h1 className="text-2xl font-semibold text-fantom-text">Create a Short</h1>
        <p className="mt-1 text-sm text-fantom-text-muted">
          Vertical 9:16 · 1080 × 1920 · AI voiceover · Runway motion clips
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* ── Step 1: Input assets ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            1 — Input Assets
            {selectedIds.length > 0 && (
              <Badge variant={selectedIds.length >= MAX_ASSETS ? 'warning' : 'neutral'} className="ml-2">
                {selectedIds.length} of {MAX_ASSETS} selected
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-fantom-text-muted">
            Select 1–{MAX_ASSETS} photos or videos from your library. Selected order sets clip sequence.
          </p>

          {libraryLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size="lg" />
            </div>
          ) : libraryAssets.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-fantom-steel-border py-10 text-center">
              <p className="text-sm text-fantom-text-muted">No images or videos in your library yet.</p>
              <button
                onClick={() => router.push('/library')}
                className="text-sm text-fantom-blue hover:underline"
              >
                Upload assets in the Library →
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
              {libraryAssets.map((asset) => (
                <AssetThumb
                  key={asset.id}
                  asset={asset}
                  selected={selectedIds.includes(asset.id)}
                  disabled={selectedIds.length >= MAX_ASSETS}
                  onClick={() => toggleAsset(asset.id)}
                />
              ))}
            </div>
          )}

          {selectedIds.length > 0 && (
            <p className="text-xs text-fantom-text-muted">
              {selectedIds.length} asset{selectedIds.length !== 1 ? 's' : ''} selected · sequence: {selectedIds.length} clips
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Step 2: Vibe ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">2 — Vibe</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-3">
            {VIBE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setVibe(opt.value)}
                className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
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
        </CardContent>
      </Card>

      {/* ── Step 3: Brand Kits ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">3 — Brand Kits</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Primary — required */}
          <div className="space-y-1.5">
            <Label htmlFor="brand-kit-primary">
              Primary brand kit <span className="text-red-400">*</span>
            </Label>
            <select
              id="brand-kit-primary"
              value={brandKitId}
              onChange={(e) => setBrandKitId(e.target.value)}
              className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue"
            >
              <option value="">— Select primary brand kit —</option>
              {brandKits.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}{k.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {/* Co-brand — optional */}
            <div className="space-y-1.5">
              <Label htmlFor="brand-kit-cobrand">Co-brand kit <span className="text-fantom-text-muted text-xs">(optional)</span></Label>
              <select
                id="brand-kit-cobrand"
                value={coBrandKitId}
                onChange={(e) => setCoBrandKitId(e.target.value)}
                className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue"
              >
                <option value="">None</option>
                {brandKits.map((k) => (
                  <option key={k.id} value={k.id}>{k.name}</option>
                ))}
              </select>
            </div>

            {/* Compliance — optional */}
            <div className="space-y-1.5">
              <Label htmlFor="brand-kit-compliance">Compliance kit <span className="text-fantom-text-muted text-xs">(optional)</span></Label>
              <select
                id="brand-kit-compliance"
                value={complianceKitId}
                onChange={(e) => setComplianceKitId(e.target.value)}
                className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue"
              >
                <option value="">None</option>
                {brandKits.map((k) => (
                  <option key={k.id} value={k.id}>{k.name}</option>
                ))}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Step 4: Voice ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">4 — Voice</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              checked={generateVoiceover}
              onChange={(e) => setGenerateVoiceover(e.target.checked)}
              className="h-4 w-4 rounded accent-fantom-blue"
            />
            <span className="text-sm text-fantom-text">Generate voiceover</span>
          </label>

          {generateVoiceover && (
            <div className="space-y-1.5">
              <Label htmlFor="voice">
                Voice clone <span className="text-red-400">*</span>
              </Label>
              <select
                id="voice"
                value={voiceCloneId}
                onChange={(e) => setVoiceCloneId(e.target.value)}
                className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue"
              >
                <option value="">— Select a voice —</option>
                {sharedVoices.length > 0 && (
                  <optgroup label="Shared">
                    {sharedVoices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </optgroup>
                )}
                {personalVoices.length > 0 && (
                  <optgroup label="Personal">
                    {personalVoices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </optgroup>
                )}
              </select>
              {voices.length === 0 && (
                <p className="text-xs text-fantom-text-muted">
                  No voices ready.{' '}
                  <a href="/voices" className="text-fantom-blue hover:underline">Create a voice clone</a> first.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Step 5: Script ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">5 — Script</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Mode toggle */}
          <div className="flex gap-1 rounded-lg border border-fantom-steel-border bg-fantom-steel p-1">
            {(['ai', 'custom'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setScriptMode(mode)}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  scriptMode === mode
                    ? 'bg-fantom-steel-lighter text-fantom-text shadow-sm'
                    : 'text-fantom-text-muted hover:text-fantom-text'
                }`}
              >
                {mode === 'ai' ? 'AI Generated' : 'Custom'}
              </button>
            ))}
          </div>

          {scriptMode === 'ai' && (
            <Button
              variant="secondary"
              onClick={handleGenerateScript}
              disabled={generatingScript || selectedIds.length === 0 || !brandKitId}
              className="w-full"
            >
              {generatingScript ? (
                <span className="flex items-center gap-2"><Spinner size="sm" /> Generating…</span>
              ) : script ? (
                'Regenerate Script'
              ) : (
                'Generate Script with AI'
              )}
            </Button>
          )}

          {(scriptMode === 'ai' && !script && !generatingScript) && (
            <p className="text-center text-xs text-fantom-text-muted">
              {selectedIds.length === 0 ? 'Select assets first' : !brandKitId ? 'Select a brand kit first' : 'Click to generate'}
            </p>
          )}

          <div className="space-y-1">
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder={scriptMode === 'ai' ? 'AI script will appear here — or type your own…' : 'Write your voiceover script…'}
              rows={6}
              className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/50 focus:outline-none focus:ring-2 focus:ring-fantom-blue"
            />
            {script && (
              <p className="text-right text-xs text-fantom-text-muted">
                {wc} words · ~{estSecs}s voiceover
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Step 6: Captions ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">6 — Captions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Mode toggle */}
          <div className="flex gap-1 rounded-lg border border-fantom-steel-border bg-fantom-steel p-1">
            {(['ai', 'custom', 'none'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setCaptionMode(mode)}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                  captionMode === mode
                    ? 'bg-fantom-steel-lighter text-fantom-text shadow-sm'
                    : 'text-fantom-text-muted hover:text-fantom-text'
                }`}
              >
                {mode === 'ai' ? 'AI' : mode === 'custom' ? 'Custom' : 'None'}
              </button>
            ))}
          </div>

          {captionMode === 'ai' && suggestedCaptions.length > 0 && (
            <div className="space-y-1.5">
              {suggestedCaptions.map((c, i) => (
                <button
                  key={i}
                  onClick={() => setCaptionText(c)}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    captionText === c
                      ? 'border-fantom-blue bg-fantom-blue/10 text-fantom-text'
                      : 'border-fantom-steel-border text-fantom-text-muted hover:border-fantom-blue/50'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {captionMode === 'ai' && suggestedCaptions.length === 0 && (
            <p className="text-xs text-fantom-text-muted">
              Generate a script above to get AI caption suggestions.
            </p>
          )}

          {captionMode !== 'none' && (
            <div className="space-y-1.5">
              <Label htmlFor="caption-input">
                {captionMode === 'custom' ? 'Caption text' : 'Or write your own'}
              </Label>
              <Input
                id="caption-input"
                value={captionText}
                onChange={(e) => setCaptionText(e.target.value)}
                placeholder="Short overlay text (≤12 words)…"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Step 7: Music Vibe ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">7 — Music Vibe <span className="font-normal text-fantom-text-muted text-xs">(optional)</span></CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            value={musicVibe}
            onChange={(e) => setMusicVibe(e.target.value)}
            placeholder="e.g. calm acoustic, upbeat electronic, no music…"
          />
        </CardContent>
      </Card>

      {/* ── Step 8: Target Duration ──────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">8 — Target Duration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="duration">
            <span className="font-semibold text-fantom-text">{targetDuration}s</span>
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
            <span>15s</span><span>120s</span>
          </div>
        </CardContent>
      </Card>

      {/* ── Step 9: SFX ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">9 — Sound Effects <span className="font-normal text-fantom-text-muted text-xs">(optional)</span></CardTitle>
        </CardHeader>
        <CardContent>
          <textarea
            value={sfxPrompt}
            onChange={(e) => setSfxPrompt(e.target.value)}
            placeholder="Describe any sound effects… (stored for future use, not yet applied to renders)"
            rows={3}
            className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/50 focus:outline-none focus:ring-2 focus:ring-fantom-blue"
          />
          <p className="mt-1 text-xs text-fantom-text-muted">
            SFX prompt is saved to the job record — execution comes in a future milestone.
          </p>
        </CardContent>
      </Card>

      {/* ── Step 10: Render ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-end gap-3 pb-8">
        <Button variant="ghost" onClick={() => router.push('/studio')} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={
            submitting ||
            selectedIds.length === 0 ||
            !brandKitId ||
            !script.trim() ||
            (generateVoiceover && !voiceCloneId)
          }
          title={
            selectedIds.length === 0 ? 'Select at least one asset' :
            !brandKitId ? 'Select a primary brand kit' :
            !script.trim() ? 'Generate or write a script' :
            (generateVoiceover && !voiceCloneId) ? 'Select a voice clone' :
            undefined
          }
        >
          {submitting ? (
            <span className="flex items-center gap-2"><Spinner size="sm" /> Starting render…</span>
          ) : (
            'Generate Short'
          )}
        </Button>
      </div>
    </div>
  )
}
