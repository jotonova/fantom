'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch, ApiError } from '../../../../../../src/lib/api-client'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@fantom/ui'

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
}

interface PreviewClip {
  id: string
  originalFilename: string
  durationSeconds: string | null
  sceneCount: number | null
  thumbnailPublicUrl: string | null
}

interface CostEstimate {
  voCharCount: number
  voCostUsd: number
  renderCostUsd: number
  totalUsd: number
}

interface ValidationResult {
  blockers: string[]
  warnings: string[]
  info: string[]
}

interface PreviewData {
  brief: ShortsBrief
  clips: PreviewClip[]
  brandKitName: string | null
  voiceCloneName: string | null
  estimates: CostEstimate
  validation: ValidationResult
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(seconds: string | number | null): string {
  if (seconds == null) return '—'
  const s = Math.round(Number(seconds))
  const m = Math.floor(s / 60)
  const rem = s % 60
  return m > 0 ? `${m}m ${rem}s` : `${s}s`
}

function fmtUsd(n: number): string {
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`
}

const STATUS_BADGE: Record<
  BriefStatus,
  { variant: 'neutral' | 'success' | 'warning' | 'danger'; className?: string; label: string }
> = {
  draft:     { variant: 'neutral',  label: 'Draft' },
  ready:     { variant: 'neutral',  label: 'Ready', className: 'border-blue-800 bg-blue-950 text-blue-400' },
  rendering: { variant: 'warning',  label: 'Rendering' },
  rendered:  { variant: 'success',  label: 'Rendered' },
  failed:    { variant: 'danger',   label: 'Failed' },
}

// ── Section components ────────────────────────────────────────────────────────

function WarningIcon({ kind }: { kind: 'blocker' | 'warning' | 'info' }) {
  if (kind === 'blocker') {
    return (
      <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
      </svg>
    )
  }
  if (kind === 'warning') {
    return (
      <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
      </svg>
    )
  }
  return (
    <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
    </svg>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PreviewPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [data, setData] = useState<PreviewData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [transitioning, setTransitioning] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  async function load() {
    try {
      const r = await apiFetch<PreviewData>(`/shorts-briefs/${id}/preview`)
      setData(r)
    } catch (err) {
      setLoadError(err instanceof ApiError && err.status === 404 ? 'Brief not found' : 'Failed to load preview')
    }
  }

  useEffect(() => { load() }, [id])

  async function handleMarkReady() {
    if (!data) return
    setActionError(null)
    setTransitioning(true)
    try {
      const updated = await apiFetch<ShortsBrief>(`/shorts-briefs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'ready' }),
      })
      setData((prev) => prev ? { ...prev, brief: updated } : prev)
      // Re-fetch to get fresh validation state
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to mark ready')
    } finally {
      setTransitioning(false)
    }
  }

  async function handleGenerate() {
    if (!data) return
    setActionError(null)
    setGenerating(true)
    try {
      await apiFetch(`/shorts-briefs/${id}/render`, { method: 'POST' })
      router.push(`/studio/shorts/${id}/render`)
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to start render')
      setGenerating(false)
    }
  }

  async function handleUnlock() {
    if (!data) return
    setActionError(null)
    setTransitioning(true)
    try {
      const updated = await apiFetch<ShortsBrief>(`/shorts-briefs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'draft' }),
      })
      setData((prev) => prev ? { ...prev, brief: updated } : prev)
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to unlock')
    } finally {
      setTransitioning(false)
    }
  }

  // ── Loading / error ────────────────────────────────────────────────────────

  if (!data && !loadError) {
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

  const { brief, clips, brandKitName, voiceCloneName, estimates, validation } = data!
  const { blockers, warnings, info } = validation
  const hasValidationIssues = blockers.length > 0 || warnings.length > 0 || info.length > 0
  const canMarkReady = brief.status === 'draft' && blockers.length === 0
  const statusConfig = STATUS_BADGE[brief.status]

  const totalClipS = clips.reduce((acc, c) => acc + (c.durationSeconds ? Number(c.durationSeconds) : 0), 0)
  const totalScenes = clips.reduce((acc, c) => acc + (c.sceneCount ?? 0), 0)

  return (
    <div className="mx-auto max-w-3xl px-4 pb-32 pt-8">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-fantom-text">{brief.title}</h1>
            <Badge variant={statusConfig.variant} className={statusConfig.className}>
              {statusConfig.label}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-fantom-text-muted">
            Target: {brief.durationSeconds}s
            {brief.pacing ? ` · ${brief.pacing} pacing` : ''}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => router.push('/studio/shorts')}>
          ← Back
        </Button>
      </div>

      {actionError && (
        <div className="mb-4 rounded-fantom border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {actionError}
        </div>
      )}

      {/* ── Brief Summary ────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Brief Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <span className="block text-xs text-fantom-text-muted">Pacing</span>
              <span className="capitalize text-fantom-text">{brief.pacing ?? '—'}</span>
            </div>
            <div>
              <span className="block text-xs text-fantom-text-muted">Brand Kit</span>
              <span className="text-fantom-text">{brandKitName ?? <em className="text-fantom-text-muted">None</em>}</span>
            </div>
            <div>
              <span className="block text-xs text-fantom-text-muted">Voice</span>
              <span className="text-fantom-text">{voiceCloneName ?? <em className="text-fantom-text-muted">None</em>}</span>
            </div>
          </div>

          {brief.opening && (
            <div>
              <span className="block text-xs text-fantom-text-muted">Opening</span>
              <p className="mt-0.5 line-clamp-2 text-fantom-text">{brief.opening}</p>
            </div>
          )}
          {brief.closing && (
            <div>
              <span className="block text-xs text-fantom-text-muted">Closing CTA</span>
              <p className="mt-0.5 line-clamp-2 text-fantom-text">{brief.closing}</p>
            </div>
          )}
          {brief.mainScenes && (
            <div>
              <span className="block text-xs text-fantom-text-muted">Main Scenes</span>
              <p className="mt-0.5 line-clamp-3 text-fantom-text">{brief.mainScenes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Selected Clips ───────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Source Clips ({clips.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {clips.length === 0 ? (
            <p className="text-sm text-fantom-text-muted">No clips selected.</p>
          ) : (
            <div className="space-y-2">
              {clips.map((clip, i) => (
                <div
                  key={clip.id}
                  className="flex items-center gap-3 rounded-fantom border border-fantom-steel-border bg-fantom-steel/30 p-2"
                >
                  {/* Order number */}
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-fantom-steel-lighter text-xs font-bold text-fantom-text-muted">
                    {i + 1}
                  </span>

                  {/* Thumbnail */}
                  <div className="h-10 w-16 flex-shrink-0 overflow-hidden rounded bg-black/40">
                    {clip.thumbnailPublicUrl ? (
                      <img src={clip.thumbnailPublicUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <svg className="h-4 w-4 text-fantom-text-muted/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </div>
                    )}
                  </div>

                  {/* Metadata */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fantom-text" title={clip.originalFilename}>
                      {clip.originalFilename}
                    </p>
                    <p className="text-xs text-fantom-text-muted">
                      {fmtDuration(clip.durationSeconds)}
                      {clip.sceneCount !== null ? ` · ${clip.sceneCount} scene${clip.sceneCount !== 1 ? 's' : ''}` : ''}
                    </p>
                  </div>
                </div>
              ))}

              {/* Sum row */}
              <div className="mt-1 flex items-center gap-2 border-t border-fantom-steel-border pt-2 text-xs text-fantom-text-muted">
                <span>Total source:</span>
                <span className="font-medium text-fantom-text">
                  {fmtDuration(totalClipS)} across {clips.length} clip{clips.length !== 1 ? 's' : ''}
                  {totalScenes > 0 ? `, ${totalScenes} scene${totalScenes !== 1 ? 's' : ''}` : ''}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Estimates ────────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Cost Estimates</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5 text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-fantom-text-muted">Target output duration</span>
              <span className="font-medium text-fantom-text">{brief.durationSeconds}s</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-fantom-text-muted">Source material</span>
              <span className="font-medium text-fantom-text">
                {clips.length > 0 ? `${fmtDuration(totalClipS)} for a ${brief.durationSeconds}s target` : '—'}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-fantom-text-muted">
                VO cost estimate
                <span className="ml-1 text-xs opacity-60">({estimates.voCharCount} chars × $0.30/1K)</span>
              </span>
              <span className="font-medium text-fantom-text">{fmtUsd(estimates.voCostUsd)}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-fantom-text-muted">
                Render cost estimate
                <span className="ml-1 text-xs opacity-60">($0.05/min)</span>
              </span>
              <span className="font-medium text-fantom-text">{fmtUsd(estimates.renderCostUsd)}</span>
            </div>
            <div className="flex items-baseline justify-between border-t border-fantom-steel-border pt-2">
              <span className="font-medium text-fantom-text">Total estimate</span>
              <span className="font-semibold text-fantom-text">{fmtUsd(estimates.totalUsd)}</span>
            </div>
            <p className="pt-1 text-xs text-fantom-text-muted">
              Estimates are approximate. Rates will be calibrated in 1B.5 after first renders.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ── Validation Warnings ──────────────────────────────────────────────── */}
      {hasValidationIssues && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Validation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {blockers.map((msg) => (
              <div key={msg} className="flex items-start gap-2 text-sm text-red-400">
                <WarningIcon kind="blocker" />
                <span>{msg}</span>
              </div>
            ))}
            {warnings.map((msg) => (
              <div key={msg} className="flex items-start gap-2 text-sm text-amber-400">
                <WarningIcon kind="warning" />
                <span>{msg}</span>
              </div>
            ))}
            {info.map((msg) => (
              <div key={msg} className="flex items-start gap-2 text-sm text-blue-400">
                <WarningIcon kind="info" />
                <span>{msg}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ── Sticky action bar ────────────────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-fantom-steel-border bg-fantom-steel/80 px-4 py-3 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => router.push(`/studio/shorts/${id}/edit`)}
            >
              Edit Brief
            </Button>
            {brief.status === 'ready' && (
              <Button
                variant="ghost"
                size="sm"
                disabled={transitioning}
                onClick={handleUnlock}
              >
                {transitioning ? 'Unlocking…' : 'Unlock for editing'}
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Draft — Mark Ready (+ blocked tooltip if needed) */}
            {brief.status === 'draft' && (
              <div className="group relative">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!canMarkReady || transitioning}
                  onClick={canMarkReady && !transitioning ? handleMarkReady : undefined}
                >
                  {transitioning ? (
                    <span className="flex items-center gap-1.5">
                      <Spinner size="sm" /> Saving…
                    </span>
                  ) : (
                    'Mark Ready'
                  )}
                </Button>
                {!canMarkReady && blockers.length > 0 && (
                  <div className="pointer-events-none absolute bottom-full right-0 mb-2 hidden w-64 rounded-fantom border border-fantom-steel-border bg-fantom-steel px-2.5 py-1.5 text-xs text-fantom-text-muted shadow-lg group-hover:block">
                    {blockers[0]}
                  </div>
                )}
              </div>
            )}

            {/* Ready — Generate */}
            {brief.status === 'ready' && (
              <Button
                variant="primary"
                size="sm"
                disabled={generating}
                onClick={handleGenerate}
              >
                {generating ? (
                  <span className="flex items-center gap-1.5">
                    <Spinner size="sm" /> Starting…
                  </span>
                ) : (
                  'Generate'
                )}
              </Button>
            )}

            {/* Rendering — live indicator linking to render detail */}
            {brief.status === 'rendering' && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => router.push(`/studio/shorts/${id}/render`)}
              >
                <span className="flex items-center gap-1.5">
                  <Spinner size="sm" />
                  Rendering… View →
                </span>
              </Button>
            )}

            {/* Rendered — link to render detail */}
            {brief.status === 'rendered' && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => router.push(`/studio/shorts/${id}/render`)}
              >
                View Render →
              </Button>
            )}

            {/* Failed — link to render detail for error info */}
            {brief.status === 'failed' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push(`/studio/shorts/${id}/render`)}
              >
                View Error →
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
