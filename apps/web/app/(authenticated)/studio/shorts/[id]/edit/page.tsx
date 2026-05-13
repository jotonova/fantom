'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch, ApiError } from '../../../../../../src/lib/api-client'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Spinner } from '@fantom/ui'
import { SourceClipPicker } from '../../_components/SourceClipPicker'

// ── Types ─────────────────────────────────────────────────────────────────────

type BriefStatus = 'draft' | 'ready' | 'rendering' | 'rendered' | 'failed'

interface Scene {
  id: string
  description: string
  voiceover_script: string
}

interface ShortsBrief {
  id: string
  title: string
  durationSeconds: number
  opening: string | null
  openingVoiceoverScript: string | null
  mainScenes: Scene[] | null
  closing: string | null
  closingVoiceoverScript: string | null
  pacing: 'fast' | 'medium' | 'slow' | null
  sourceAssetIds: string[]
  brandKitId: string | null
  voiceCloneId: string | null
  musicTrackId: string | null
  captionsEnabled: boolean
  status: BriefStatus
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

interface ClipMeta {
  id: string
  originalFilename: string
  durationSeconds: string | null
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

interface MusicTrack {
  id: string
  slug: string
  title: string
  mood: string | null
  durationSeconds: number | null
  previewUrl: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(seconds: string | number | null): string {
  if (seconds == null) return '—'
  const s = Math.round(Number(seconds))
  const m = Math.floor(s / 60)
  const rem = s % 60
  return m > 0 ? `${m}:${rem.toString().padStart(2, '0')}` : `0:${rem.toString().padStart(2, '0')}`
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_VARIANTS: Record<BriefStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  ready: 'success',
  rendering: 'warning',
  rendered: 'success',
  failed: 'danger',
}

// ── Scene helpers ─────────────────────────────────────────────────────────────

function makeScene(index: number): Scene {
  return { id: `scene-${index + 1}`, description: '', voiceover_script: '' }
}

function apiSceneToLocal(s: { id: string; description: string; voiceover_script?: string }): Scene {
  return { id: s.id, description: s.description, voiceover_script: s.voiceover_script ?? '' }
}

function SceneBlock({
  scene,
  index,
  total,
  disabled,
  onChange,
  onRemove,
}: {
  scene: Scene
  index: number
  total: number
  disabled: boolean
  onChange: (updated: Scene) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-fantom border border-fantom-steel-border bg-fantom-steel/20 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-fantom-text-muted uppercase tracking-wide">
          Scene {index + 1}
        </span>
        {total > 1 && !disabled && (
          <button
            type="button"
            onClick={onRemove}
            className="text-xs text-fantom-text-muted hover:text-red-400 transition-colors"
          >
            Remove
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`scene-${scene.id}-desc`}>Description</Label>
        <textarea
          id={`scene-${scene.id}-desc`}
          value={scene.description}
          onChange={(e) => onChange({ ...scene, description: e.target.value })}
          disabled={disabled}
          rows={2}
          maxLength={2000}
          placeholder="What happens in this scene? What should the camera show?"
          className="w-full resize-y rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/60 focus:outline-none focus:ring-2 focus:ring-fantom-blue disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`scene-${scene.id}-vo`}>
          Voiceover script <span className="text-fantom-text-muted font-normal">(optional)</span>
        </Label>
        <textarea
          id={`scene-${scene.id}-vo`}
          value={scene.voiceover_script}
          onChange={(e) => onChange({ ...scene, voiceover_script: e.target.value })}
          disabled={disabled}
          rows={2}
          maxLength={5000}
          placeholder="What should be said during this scene?"
          className="w-full resize-y rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/60 focus:outline-none focus:ring-2 focus:ring-fantom-blue disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    </div>
  )
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
  const [openingVoiceoverScript, setOpeningVoiceoverScript] = useState('')
  const [scenes, setScenes] = useState<Scene[]>([makeScene(0)])
  const [closing, setClosing] = useState('')
  const [closingVoiceoverScript, setClosingVoiceoverScript] = useState('')
  const [sourceAssetIds, setSourceAssetIds] = useState<string[]>([])
  const [brandKitId, setBrandKitId] = useState<string>('')
  const [voiceCloneId, setVoiceCloneId] = useState<string>('')
  const [musicTrackId, setMusicTrackId] = useState<string>('')
  const [captionsEnabled, setCaptionsEnabled] = useState(true)

  // Reference data
  const [clipMetaMap, setClipMetaMap] = useState<Record<string, ClipMeta>>({})
  const [brandKits, setBrandKits] = useState<BrandKit[]>([])
  const [voices, setVoices] = useState<VoiceClone[]>([])
  const [musicTracks, setMusicTracks] = useState<MusicTrack[]>([])
  const [previewingTrackId, setPreviewingTrackId] = useState<string | null>(null)

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
        setOpeningVoiceoverScript(b.openingVoiceoverScript ?? '')
        setScenes(
          b.mainScenes && b.mainScenes.length > 0
            ? b.mainScenes.map(apiSceneToLocal)
            : [makeScene(0)],
        )
        setClosing(b.closing ?? '')
        setClosingVoiceoverScript(b.closingVoiceoverScript ?? '')
        setSourceAssetIds(b.sourceAssetIds)
        setBrandKitId(b.brandKitId ?? '')
        setVoiceCloneId(b.voiceCloneId ?? '')
        setMusicTrackId(b.musicTrackId ?? '')
        setCaptionsEnabled(b.captionsEnabled ?? true)
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError && err.status === 404 ? 'Brief not found' : 'Failed to load brief')
      })

    apiFetch<{ assets: Array<{ id: string; originalFilename: string; durationSeconds: string | null; normalizedR2Key: string | null }> }>(
      '/assets?kind=video&source=upload&limit=100',
    )
      .then((r) => {
        const map: Record<string, ClipMeta> = {}
        for (const a of r.assets ?? []) {
          if (a.normalizedR2Key !== null) map[a.id] = { id: a.id, originalFilename: a.originalFilename, durationSeconds: a.durationSeconds }
        }
        setClipMetaMap(map)
      })
      .catch(() => {})

    apiFetch<{ brandKits: BrandKit[] }>('/brand-kits')
      .then((r) => setBrandKits(r.brandKits ?? []))
      .catch(() => {})

    apiFetch<{ voices: VoiceClone[] }>('/voices')
      .then((r) => setVoices((r.voices ?? []).filter((v) => v.status === 'ready')))
      .catch(() => {})

    apiFetch<{ musicTracks: MusicTrack[] }>('/music-tracks')
      .then((r) => setMusicTracks(r.musicTracks ?? []))
      .catch(() => {})
  }, [id])

  function updateScene(index: number, updated: Scene) {
    setScenes((prev) => prev.map((s, i) => (i === index ? updated : s)))
  }

  function removeScene(index: number) {
    setScenes((prev) => prev.filter((_, i) => i !== index))
  }

  function addScene() {
    setScenes((prev) => [...prev, makeScene(prev.length)])
  }

  function addSceneForClip(clipIndex: number) {
    setScenes((prev) => {
      const next = [...prev]
      // Pad with empty scenes up to the required index
      while (next.length <= clipIndex) next.push(makeScene(next.length))
      return next
    })
  }

  async function handleSave() {
    setSaveError(null)
    setSaved(false)

    if (!title.trim()) { setSaveError('Title is required'); return }
    if (sourceAssetIds.length === 0) { setSaveError('Select at least one source clip'); return }

    const validScenes = scenes.filter((s) => s.description.trim())
    const mainScenes = validScenes.length > 0
      ? validScenes.map((s) => ({
          id: s.id,
          description: s.description.trim(),
          ...(s.voiceover_script.trim() ? { voiceover_script: s.voiceover_script.trim() } : {}),
        }))
      : null

    setSaving(true)
    try {
      const updated = await apiFetch<ShortsBrief>(`/shorts-briefs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: title.trim(),
          durationSeconds,
          pacing: pacing || null,
          opening: opening || null,
          openingVoiceoverScript: openingVoiceoverScript || null,
          mainScenes,
          closing: closing || null,
          closingVoiceoverScript: closingVoiceoverScript || null,
          sourceAssetIds,
          brandKitId: brandKitId || null,
          voiceCloneId: voiceCloneId || null,
          musicTrackId: musicTrackId || null,
          captionsEnabled,
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
    const briefTitle = brief?.title || 'this brief'
    if (!confirm(`Delete brief "${briefTitle}"? This will permanently remove the brief and any rendered output. Cannot be undone.`)) return
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
          <div className="space-y-1.5">
            <Label htmlFor="opening">Opening hook</Label>
            <p className="text-xs text-fantom-text-muted">What grabs attention in the first 3 seconds? (direction for the editor)</p>
            <textarea
              id="opening"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
              disabled={isLocked}
              rows={2}
              maxLength={2000}
              className="w-full resize-y rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/60 focus:outline-none focus:ring-2 focus:ring-fantom-blue disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="openingVO">
              Opening voiceover <span className="text-fantom-text-muted font-normal">(optional)</span>
            </Label>
            <textarea
              id="openingVO"
              value={openingVoiceoverScript}
              onChange={(e) => setOpeningVoiceoverScript(e.target.value)}
              disabled={isLocked}
              rows={2}
              maxLength={5000}
              placeholder="What the voice says at the very start of the video…"
              className="w-full resize-y rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/60 focus:outline-none focus:ring-2 focus:ring-fantom-blue disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          {/* Clip → Scene map (shows when clips are selected) */}
          {sourceAssetIds.length > 0 && (
            <div className="space-y-1.5">
              <Label>Clip → Scene Map</Label>
              <p className="text-xs text-fantom-text-muted">
                Scene {1} plays over Clip {1}, Scene {2} over Clip {2}, etc. Clips without a mapped scene play with original audio.
              </p>
              <div className="space-y-1">
                {sourceAssetIds.map((assetId, clipIndex) => {
                  const clip = clipMetaMap[assetId]
                  const scene = scenes[clipIndex]
                  const hasMappedScene = Boolean(scene?.description?.trim())
                  return (
                    <div
                      key={assetId}
                      className="flex flex-wrap items-center gap-1.5 rounded-fantom border border-fantom-steel-border bg-fantom-steel/20 px-3 py-2 text-sm"
                    >
                      <span className="font-medium text-fantom-text-muted flex-shrink-0">
                        Clip {clipIndex + 1}
                        {clip && (
                          <span className="ml-1 text-xs font-normal text-fantom-text-muted/60">
                            {clip.originalFilename}
                            {clip.durationSeconds ? ` · ${fmtDuration(clip.durationSeconds)}` : ''}
                          </span>
                        )}
                      </span>
                      <span className="text-fantom-text-muted/40 flex-shrink-0">→</span>
                      {hasMappedScene ? (
                        <span className="text-fantom-text line-clamp-1 flex-1">{scene!.description}</span>
                      ) : (
                        <>
                          <span className="flex-1 text-xs italic text-fantom-text-muted/60">
                            No scene mapped — original audio will play
                          </span>
                          {!isLocked && (
                            <button
                              type="button"
                              onClick={() => addSceneForClip(clipIndex)}
                              className="ml-auto flex-shrink-0 text-xs text-fantom-blue hover:underline"
                            >
                              + Add scene
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
              {scenes.filter(s => s.description.trim()).length > sourceAssetIds.length && (
                <div className="flex items-start gap-2 rounded-fantom border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                  {(() => {
                    const extra = scenes.filter(s => s.description.trim()).length - sourceAssetIds.length
                    return `${extra} scene${extra !== 1 ? 's' : ''} past the last clip — VO for those scenes will be skipped.`
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Scene blocks */}
          <div className="space-y-2">
            <Label>Main Scenes</Label>
            <p className="text-xs text-fantom-text-muted">
              Each scene has a description (what the camera shows) and an optional voiceover script.
            </p>
            <div className="space-y-2">
              {scenes.map((scene, i) => (
                <SceneBlock
                  key={scene.id}
                  scene={scene}
                  index={i}
                  total={scenes.length}
                  disabled={isLocked}
                  onChange={(updated) => updateScene(i, updated)}
                  onRemove={() => removeScene(i)}
                />
              ))}
            </div>
            {!isLocked && (
              <button
                type="button"
                onClick={addScene}
                className="mt-1 text-sm text-fantom-blue hover:underline"
              >
                + Add scene
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="closing">Closing CTA</Label>
            <p className="text-xs text-fantom-text-muted">What should the viewer do or feel at the end? (direction for the editor)</p>
            <textarea
              id="closing"
              value={closing}
              onChange={(e) => setClosing(e.target.value)}
              disabled={isLocked}
              rows={2}
              maxLength={2000}
              className="w-full resize-y rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/60 focus:outline-none focus:ring-2 focus:ring-fantom-blue disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="closingVO">
              Closing voiceover <span className="text-fantom-text-muted font-normal">(optional)</span>
            </Label>
            <textarea
              id="closingVO"
              value={closingVoiceoverScript}
              onChange={(e) => setClosingVoiceoverScript(e.target.value)}
              disabled={isLocked}
              rows={2}
              maxLength={5000}
              placeholder="What the voice says at the very end of the video…"
              className="w-full resize-y rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/60 focus:outline-none focus:ring-2 focus:ring-fantom-blue disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
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

          <div className="space-y-1.5">
            <Label htmlFor="music">Background Music</Label>
            <p className="text-xs text-fantom-text-muted">
              Plays under the voiceover, ducked during speech. Optional.
            </p>
            <select
              id="music"
              value={musicTrackId}
              onChange={(e) => {
                setMusicTrackId(e.target.value)
                setPreviewingTrackId(null)
              }}
              disabled={isLocked}
              className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">— none —</option>
              {musicTracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}{t.mood ? ` · ${t.mood}` : ''}{t.durationSeconds ? ` (${fmtDuration(t.durationSeconds)})` : ''}
                </option>
              ))}
            </select>
            {musicTrackId && (() => {
              const track = musicTracks.find((t) => t.id === musicTrackId)
              if (!track) return null
              return (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() =>
                      setPreviewingTrackId((prev) => (prev === track.id ? null : track.id))
                    }
                    className="text-xs text-fantom-blue hover:underline"
                  >
                    {previewingTrackId === track.id ? 'Stop preview' : 'Preview'}
                  </button>
                  {previewingTrackId === track.id && (
                    <audio
                      key={track.id}
                      src={track.previewUrl}
                      autoPlay
                      controls
                      onEnded={() => setPreviewingTrackId(null)}
                      className="h-7 flex-1 min-w-0"
                    />
                  )}
                </div>
              )
            })()}
          </div>

          <div className="flex items-center justify-between gap-4 pt-1">
            <div>
              <Label htmlFor="captions">Burned-in Captions</Label>
              <p className="text-xs text-fantom-text-muted">
                Transcribed speech overlaid as styled text. No extra cost.
              </p>
            </div>
            <button
              id="captions"
              type="button"
              role="switch"
              aria-checked={captionsEnabled}
              onClick={() => !isLocked && setCaptionsEnabled((v) => !v)}
              disabled={isLocked}
              className={[
                'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-fantom-blue',
                captionsEnabled ? 'bg-fantom-blue' : 'bg-fantom-steel-border',
                isLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
              ].join(' ')}
            >
              <span
                className={[
                  'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform',
                  captionsEnabled ? 'translate-x-4' : 'translate-x-0',
                ].join(' ')}
              />
            </button>
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
