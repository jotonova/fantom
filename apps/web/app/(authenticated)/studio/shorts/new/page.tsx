'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch, ApiError } from '../../../../../src/lib/api-client'
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Spinner } from '@fantom/ui'
import { SourceClipPicker } from '../_components/SourceClipPicker'

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Component ─────────────────────────────────────────────────────────────────

export default function NewShortsBriefPage() {
  const router = useRouter()

  // Form fields
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
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<{ brandKits: BrandKit[] }>('/brand-kits')
      .then((r) => setBrandKits(r.brandKits ?? []))
      .catch(() => {})

    apiFetch<{ voices: VoiceClone[] }>('/voices')
      .then((r) => setVoices((r.voices ?? []).filter((v) => v.status === 'ready')))
      .catch(() => {})
  }, [])

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

    setSaving(true)
    try {
      const brief = await apiFetch<{ id: string }>('/shorts-briefs', {
        method: 'POST',
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

      {/* Title */}
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

          {/* Duration */}
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

          {/* Pacing */}
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
              What grabs attention in the first 3 seconds?
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
            <Label htmlFor="mainScenes">Main scenes</Label>
            <p className="text-xs text-fantom-text-muted">
              Describe the key moments and what each should show.
            </p>
            <textarea
              id="mainScenes"
              value={mainScenes}
              onChange={(e) => setMainScenes(e.target.value)}
              rows={4}
              maxLength={10000}
              placeholder="e.g. Kitchen — highlight the island and appliances. Living room — show the fireplace and view. Primary suite — slow pan across the bathroom…"
              className="w-full resize-y rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/60 focus:outline-none focus:ring-2 focus:ring-fantom-blue"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="voiceoverScripts">Voiceover notes</Label>
            <p className="text-xs text-fantom-text-muted">
              Key points, tone, or draft script lines for the AI.
            </p>
            <textarea
              id="voiceoverScripts"
              value={voiceoverScripts}
              onChange={(e) => setVoiceoverScripts(e.target.value)}
              rows={3}
              maxLength={10000}
              placeholder="e.g. Warm and confident tone. Mention the price, location, and open house date. End with a call to action."
              className="w-full resize-y rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted/60 focus:outline-none focus:ring-2 focus:ring-fantom-blue"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="closing">Closing CTA</Label>
            <p className="text-xs text-fantom-text-muted">
              What should the viewer do or feel at the end?
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
