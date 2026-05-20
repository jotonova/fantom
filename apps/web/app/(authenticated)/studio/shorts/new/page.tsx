'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch, ApiError } from '../../../../../src/lib/api-client'
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Spinner } from '@fantom/ui'
import { SourceClipPicker } from '../_components/SourceClipPicker'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Scene {
  id: string
  description: string
  voiceover_script: string
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

// ── Scene helpers ─────────────────────────────────────────────────────────────

function makeScene(index: number): Scene {
  return { id: `scene-${index + 1}`, description: '', voiceover_script: '' }
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
        <Label htmlFor={`scene-${scene.id}-vo`}>Voiceover script <span className="text-fantom-text-muted font-normal">(optional)</span></Label>
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

export default function NewShortsBriefPage() {
  const router = useRouter()

  // Form fields
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
  const [brandKits, setBrandKits] = useState<BrandKit[]>([])
  const [voices, setVoices] = useState<VoiceClone[]>([])
  const [musicTracks, setMusicTracks] = useState<MusicTrack[]>([])
  const [previewingTrackId, setPreviewingTrackId] = useState<string | null>(null)

  // UI state
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<{ brandKits: BrandKit[] }>('/brand-kits')
      .then((r) => setBrandKits(r.brandKits ?? []))
      .catch(() => {})

    apiFetch<{ voices: VoiceClone[] }>('/voices')
      .then((r) => setVoices((r.voices ?? []).filter((v) => v.status === 'ready')))
      .catch(() => {})

    apiFetch<{ musicTracks: MusicTrack[] }>('/music-tracks')
      .then((r) => setMusicTracks(r.musicTracks ?? []))
      .catch(() => {})
  }, [])

  function updateScene(index: number, updated: Scene) {
    setScenes((prev) => prev.map((s, i) => (i === index ? updated : s)))
  }

  function removeScene(index: number) {
    setScenes((prev) => prev.filter((_, i) => i !== index))
  }

  function addScene() {
    setScenes((prev) => [...prev, makeScene(prev.length)])
  }

  async function handleSave() {
    setError(null)

    if (!title.trim()) {
      setError('Title is required')
      return
    }
    if (sourceAssetIds.length === 0) {
      setError('Select at least one source clip')
      return
    }

    // Keep scenes that have either a description or a voiceover script
    const validScenes = scenes.filter((s) => s.description.trim() || s.voiceover_script.trim())
    const mainScenes = validScenes.length > 0
      ? validScenes.map((s) => ({
          id: s.id,
          description: s.description.trim(),
          ...(s.voiceover_script.trim() ? { voiceover_script: s.voiceover_script.trim() } : {}),
        }))
      : null

    setSaving(true)
    try {
      const brief = await apiFetch<{ id: string }>('/shorts-briefs', {
        method: 'POST',
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
      router.push(`/studio/shorts/${brief.id}/edit`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed — please try again')
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-fantom-text">New Short Brief</h1>
          <p className="mt-0.5 text-sm text-fantom-text-muted">
            Describe your short. The AI uses this to plan scenes and voiceover.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => router.push('/studio/shorts')}>
          ← Back
        </Button>
      </div>

      {error && (
        <div className="rounded-fantom border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
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
              placeholder="e.g. Spring Listing — 123 Oak Street"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
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
                  onClick={() => setDurationSeconds(d)}
                  className={[
                    'rounded-fantom border px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-fantom-blue',
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
              className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue"
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
            <p className="text-xs text-fantom-text-muted">
              What grabs attention in the first 3 seconds? (direction for the editor)
            </p>
            <textarea
              id="opening"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="e.g. Pan across the pool at golden hour while music swells…"
              className="w-full resize-y rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/60 focus:outline-none focus:ring-2 focus:ring-fantom-blue"
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
              rows={2}
              maxLength={5000}
              placeholder="What the voice says at the very start of the video…"
              className="w-full resize-y rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/60 focus:outline-none focus:ring-2 focus:ring-fantom-blue"
            />
          </div>

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
                  disabled={saving}
                  onChange={(updated) => updateScene(i, updated)}
                  onRemove={() => removeScene(i)}
                />
              ))}
            </div>
            {!saving && (
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
            <p className="text-xs text-fantom-text-muted">
              What should the viewer do or feel at the end? (direction for the editor)
            </p>
            <textarea
              id="closing"
              value={closing}
              onChange={(e) => setClosing(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="e.g. Book a showing today — link in bio."
              className="w-full resize-y rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/60 focus:outline-none focus:ring-2 focus:ring-fantom-blue"
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
              rows={2}
              maxLength={5000}
              placeholder="What the voice says at the very end of the video…"
              className="w-full resize-y rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/60 focus:outline-none focus:ring-2 focus:ring-fantom-blue"
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
          <SourceClipPicker value={sourceAssetIds} onChange={setSourceAssetIds} />
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
              className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue"
            >
              <option value="">— none —</option>
              {brandKits.map((kit) => (
                <option key={kit.id} value={kit.id}>
                  {kit.name}{kit.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Brand Overlays summary — shown when a brand kit is selected */}
          {brandKitId && (
            <div className="rounded-fantom border border-fantom-steel-border bg-fantom-steel/40 px-4 py-3 text-sm">
              <p className="mb-2 font-medium text-fantom-text">Brand Overlays</p>
              <ul className="space-y-1 text-fantom-text-muted">
                <li>&#10003; Brand watermark (top-right logo throughout)</li>
              </ul>
              <p className="mt-2 text-xs text-fantom-text-muted/70">
                Watermark is auto-applied from the selected brand kit logo.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="voice">Voice</Label>
            {voices.length === 0 ? (
              <p className="text-xs text-fantom-text-muted">
                No ready voice clones found. Add voices in{' '}
                <a href="/studio/voices" className="text-fantom-blue underline">
                  Voice Studio
                </a>
                .
              </p>
            ) : (
              <select
                id="voice"
                value={voiceCloneId}
                onChange={(e) => setVoiceCloneId(e.target.value)}
                className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue"
              >
                <option value="">— none —</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.providerVoiceId ?? v.id}>
                    {v.name}
                    {v.isPersonal ? ' (personal)' : ''}
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
              className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue"
            >
              <option value="">— none —</option>
              {musicTracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}{t.mood ? ` · ${t.mood}` : ''}{t.durationSeconds ? ` (${Math.floor(t.durationSeconds / 60)}:${String(t.durationSeconds % 60).padStart(2, '0')})` : ''}
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
              onClick={() => setCaptionsEnabled((v) => !v)}
              className={[
                'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-fantom-blue',
                captionsEnabled ? 'bg-fantom-blue' : 'bg-fantom-steel-border',
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
      <div className="flex items-center justify-end gap-3 pb-8">
        <Button variant="ghost" onClick={() => router.push('/studio/shorts')} disabled={saving}>
          Cancel
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
            'Save as Draft'
          )}
        </Button>
      </div>
    </div>
  )
}
