'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch, ApiError } from '../../../../../../src/lib/api-client'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Spinner } from '@fantom/ui'
import { SourceClipPicker } from '../../_components/SourceClipPicker'

// ── Types ─────────────────────────────────────────────────────────────────────

type BriefStatus = 'draft' | 'ready' | 'rendering' | 'rendered' | 'failed'

interface ShortsBrief {
  id: string
  title: string
  durationSeconds: number
  opening: string | null
  mainScenes: string | null
  voiceoverScripts: string | null
  closing: string | null
  pacing: 'fast' | 'medium' | 'slow' | null
  sourceAssetIds: string[]
  brandKitId: string | null
  voiceCloneId: string | null
  status: BriefStatus
  errorMessage: string | null
  createdAt: string
  updatedAt: string
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
  providerVoiceId: string | null
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_VARIANTS: Record<BriefStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  ready: 'success',
  rendering: 'warning',
  rendered: 'success',
  failed: 'danger',
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function EditShortsBriefPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  // Brief data
  const [brief, setBrief] = useState<ShortsBrief | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Form fields (synced from brief on load)
  const [title, setTitle] = useState('')
  const [durationSeconds, setDurationSeconds] = useState<15 | 30 | 45 | 60>(30)
  const [pacing, setPacing] = useState<'fast' | 'medium' | 'slow' | ''>('')
  const [opening, setOpening] = useState('')
  const [mainScenes, setMainScenes] = useState('')
  const [voiceoverScripts, setVoiceoverScripts] = useState('')
  const [closing, setClosing] = useState('')
  const [sourceAssetIds, setSourceAssetIds] = useState<string[]>([])
  const [brandKitId, setBrandKitId] = useState<string>('')
  const [voiceCloneId, setVoiceCloneId] = useState<string>('')

  // Reference data
  const [brandKits, setBrandKits] = useState<BrandKit[]>([])
  const [voices, setVoices] = useState<VoiceClone[]>([])

  // UI state
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    apiFetch<ShortsBrief>(`/shorts-briefs/${id}`)
      .then((b) => {
        setBrief(b)
        setTitle(b.title)
        setDurationSeconds(b.durationSeconds as 15 | 30 | 45 | 60)
        setPacing(b.pacing ?? '')
        setOpening(b.opening ?? '')
        setMainScenes(b.mainScenes ?? '')
        setVoiceoverScripts(b.voiceoverScripts ?? '')
        setClosing(b.closing ?? '')
        setSourceAssetIds(b.sourceAssetIds)
        setBrandKitId(b.brandKitId ?? '')
        setVoiceCloneId(b.voiceCloneId ?? '')
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError && err.status === 404 ? 'Brief not found' : 'Failed to load brief')
      })

    apiFetch<{ brandKits: BrandKit[] }>('/brand-kits')
      .then((r) => setBrandKits(r.brandKits ?? []))
      .catch(() => {})

    apiFetch<{ voices: VoiceClone[] }>('/voices')
      .then((r) => setVoices((r.voices ?? []).filter((v) => v.status === 'ready')))
      .catch(() => {})
  }, [id])

  async function handleSave() {
    setSaveError(null)
    setSaved(false)

    if (!title.trim()) { setSaveError('Title is required'); return }
    if (sourceAssetIds.length === 0) { setSaveError('Select at least one source clip'); return }

    setSaving(true)
    try {
      const updated = await apiFetch<ShortsBrief>(`/shorts-briefs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: title.trim(),
          durationSeconds,
          pacing: pacing || null,
          opening: opening || null,
          mainScenes: mainScenes || null,
          voiceoverScripts: voiceoverScripts || null,
          closing: closing || null,
          sourceAssetIds,
          brandKitId: brandKitId || null,
          voiceCloneId: voiceCloneId || null,
        }),
      })
      setBrief(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Save failed — please try again')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    const title = brief?.title || 'this brief'
    if (!confirm(`Delete brief "${title}"? This will permanently remove the brief and any rendered output. Cannot be undone.`)) return
    setDeleting(true)
    try {
      await apiFetch(`/shorts-briefs/${id}`, { method: 'DELETE' })
      router.push('/studio/shorts')
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Delete failed')
      setDeleting(false)
    }
  }

  // ── Loading / error states ─────────────────────────────────────────────────

  if (!brief && !loadError) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="lg" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="rounded-fantom border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {loadError}
        </div>
      </div>
    )
  }

  const isLocked = brief!.status !== 'draft'
  const canDelete = brief!.status !== 'rendering'

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-fantom-text">{brief!.title}</h1>
            <Badge variant={STATUS_VARIANTS[brief!.status]}>{brief!.status}</Badge>
          </div>
          <p className="mt-0.5 text-sm text-fantom-text-muted">
            Created {new Date(brief!.createdAt).toLocaleDateString()}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => router.push('/studio/shorts')}>
          ← Back
        </Button>
      </div>

      {/* Locked banner */}
      {isLocked && (
        <div className="rounded-fantom border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
          Brief is locked once rendering starts. Fields are read-only.
        </div>
      )}

      {/* Error / success toasts */}
      {saveError && (
        <div className="rounded-fantom border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {saveError}
        </div>
      )}
      {saved && (
        <div className="flex items-center justify-between rounded-fantom border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-400">
          <span>Brief saved.</span>
          <button
            onClick={() => router.push(`/studio/shorts/${id}/preview`)}
            className="ml-4 underline hover:no-underline"
          >
            Preview your brief →
          </button>
        </div>
      )}
      {brief!.errorMessage && (
        <div className="rounded-fantom border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <strong>Error:</strong> {brief!.errorMessage}
        </div>
      )}

      {/* Title + duration + pacing */}
      <Card>
        <CardHeader>
          <CardTitle>Brief Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="title">
              Title <span className="text-red-400">*</span>
            </Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isLocked}
              maxLength={255}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Duration</Label>
            <div className="flex gap-2">
              {([15, 30, 45, 60] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => !isLocked && setDurationSeconds(d)}
                  disabled={isLocked}
                  className={[
                    'rounded-fantom border px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-fantom-blue',
                    isLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                    durationSeconds === d
                      ? 'border-fantom-blue bg-fantom-blue/20 text-fantom-blue'
                      : 'border-fantom-steel-border bg-fantom-steel text-fantom-text hover:border-fantom-blue/50',
                  ].join(' ')}
                >
                  {d}s
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pacing">Pacing</Label>
            <select
              id="pacing"
              value={pacing}
              onChange={(e) => setPacing(e.target.value as typeof pacing)}
              disabled={isLocked}
              className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">— not set —</option>
              <option value="fast">Fast — punchy, quick cuts</option>
              <option value="medium">Medium — balanced pacing</option>
              <option value="slow">Slow — measured, cinematic</option>
            </select>
          </div>
        </CardContent>
      </Card>

      {/* Creative brief */}
      <Card>
        <CardHeader>
          <CardTitle>Creative Brief</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {[
            { id: 'opening', label: 'Opening hook', hint: 'What grabs attention in the first 3 seconds?', value: opening, set: setOpening, rows: 2 },
            { id: 'mainScenes', label: 'Main scenes', hint: 'Key moments and what each should show.', value: mainScenes, set: setMainScenes, rows: 4 },
            { id: 'voiceoverScripts', label: 'Voiceover notes', hint: 'Tone, key points, or draft script lines.', value: voiceoverScripts, set: setVoiceoverScripts, rows: 3 },
            { id: 'closing', label: 'Closing CTA', hint: 'What should the viewer do or feel at the end?', value: closing, set: setClosing, rows: 2 },
          ].map((field) => (
            <div key={field.id} className="space-y-1.5">
              <Label htmlFor={field.id}>{field.label}</Label>
              {field.hint && <p className="text-xs text-fantom-text-muted">{field.hint}</p>}
              <textarea
                id={field.id}
                value={field.value}
                onChange={(e) => field.set(e.target.value)}
                disabled={isLocked}
                rows={field.rows}
                maxLength={10000}
                className="w-full resize-y rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/60 focus:outline-none focus:ring-2 focus:ring-fantom-blue disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Source clips */}
      <Card>
        <CardHeader>
          <CardTitle>
            Source Clips <span className="text-red-400">*</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SourceClipPicker
            value={sourceAssetIds}
            onChange={setSourceAssetIds}
            disabled={isLocked}
          />
        </CardContent>
      </Card>

      {/* Brand & Voice */}
      <Card>
        <CardHeader>
          <CardTitle>Brand &amp; Voice</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="brandKit">Brand Kit</Label>
            <select
              id="brandKit"
              value={brandKitId}
              onChange={(e) => setBrandKitId(e.target.value)}
              disabled={isLocked}
              className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">— none —</option>
              {brandKits.map((kit) => (
                <option key={kit.id} value={kit.id}>
                  {kit.name}{kit.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="voice">Voice</Label>
            {voices.length === 0 ? (
              <p className="text-xs text-fantom-text-muted">No ready voice clones found.</p>
            ) : (
              <select
                id="voice"
                value={voiceCloneId}
                onChange={(e) => setVoiceCloneId(e.target.value)}
                disabled={isLocked}
                className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">— none —</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.providerVoiceId ?? v.id}>
                    {v.name}{v.isPersonal ? ' (personal)' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex items-center justify-between pb-8">
        {canDelete && (
          <Button
            variant="danger"
            size="sm"
            onClick={handleDelete}
            disabled={deleting || saving}
          >
            {deleting ? 'Deleting…' : 'Delete Brief'}
          </Button>
        )}

        {!isLocked && (
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              onClick={() => router.push(`/studio/shorts/${id}/preview`)}
              disabled={saving}
            >
              Preview
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={saving || !title.trim() || sourceAssetIds.length === 0}
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <Spinner size="sm" /> Saving…
                </span>
              ) : (
                'Save Changes'
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
