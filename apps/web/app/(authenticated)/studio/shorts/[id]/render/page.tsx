'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch, ApiError } from '../../../../../../src/lib/api-client'
import { Badge, Button, Spinner } from '@fantom/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

type RenderStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
type BriefStatus = 'draft' | 'ready' | 'rendering' | 'rendered' | 'failed'

interface ShortsRender {
  id: string
  briefId: string
  status: RenderStatus
  bullmqJobId: string | null
  outputAssetId: string | null
  outputUrl: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  createdAt: string
  updatedAt: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set<RenderStatus>(['queued', 'running'])

const STATUS_CONFIG: Record<
  RenderStatus,
  { variant: 'neutral' | 'success' | 'warning' | 'danger'; label: string; className?: string }
> = {
  queued:    { variant: 'neutral',  label: 'Queued' },
  running:   { variant: 'warning',  label: 'Rendering' },
  completed: { variant: 'success',  label: 'Completed' },
  failed:    { variant: 'danger',   label: 'Failed' },
  cancelled: { variant: 'neutral',  label: 'Cancelled' },
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RenderStatusPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const [render, setRender] = useState<ShortsRender | null>(null)
  const [briefTitle, setBriefTitle] = useState<string>('')
  const [briefStatus, setBriefStatus] = useState<BriefStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [unlocking, setUnlocking] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const loadRender = useCallback(async () => {
    try {
      const r = await apiFetch<ShortsRender>(`/shorts-briefs/${id}/render`)
      setRender(r)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // No render yet — redirect to preview
        router.replace(`/studio/shorts/${id}/preview`)
      } else {
        setError('Failed to load render status')
      }
    }
  }, [id, router])

  // Initial data load — fetch full brief for title + status
  useEffect(() => {
    apiFetch<{ title: string; status: BriefStatus }>(`/shorts-briefs/${id}`)
      .then((b) => {
        setBriefTitle(b.title)
        setBriefStatus(b.status)
      })
      .catch(() => {})
    loadRender()
  }, [id, loadRender])

  // Poll every 3s while render is active
  useEffect(() => {
    if (!render || !ACTIVE_STATUSES.has(render.status)) return
    const t = setInterval(loadRender, 3_000)
    return () => clearInterval(t)
  }, [render, loadRender])

  async function handleTryAgain() {
    if (!window.confirm('Reset this brief to draft so you can adjust and generate again?')) return
    setUnlocking(true)
    try {
      await apiFetch(`/shorts-briefs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'draft' }) })
      router.push(`/studio/shorts/${id}/preview`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reset brief')
      setUnlocking(false)
    }
  }

  async function handleCancel() {
    if (!render) return
    setCancelling(true)
    try {
      await apiFetch(`/shorts-renders/${render.id}/cancel`, { method: 'POST' })
      await loadRender()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cancel failed')
    } finally {
      setCancelling(false)
    }
  }

  async function handleDelete() {
    const title = briefTitle || 'this brief'
    if (!window.confirm(`Delete brief "${title}"? This will permanently remove the brief and any rendered output. Cannot be undone.`)) return
    setDeleting(true)
    try {
      await apiFetch(`/shorts-briefs/${id}`, { method: 'DELETE' })
      router.push('/studio/shorts')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed')
      setDeleting(false)
    }
  }

  // ── Loading / error states ────────────────────────────────────────────────

  if (!render && !error) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="lg" />
      </div>
    )
  }

  if (error && !render) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="rounded-fantom border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      </div>
    )
  }

  const r = render!
  const cfg = STATUS_CONFIG[r.status]
  const isActive = ACTIVE_STATUSES.has(r.status)

  // Try Again: only when render is terminal AND brief is actually in a retryable state
  const canTryAgain =
    (r.status === 'failed' || r.status === 'cancelled') &&
    briefStatus !== 'rendering'

  // Delete: allowed when render is terminal (not queued/running)
  const canDelete = !isActive

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-fantom-text">
              {briefTitle || 'Render'}
            </h1>
            <Badge
              variant={cfg.variant}
              className={[
                cfg.className,
                isActive ? 'animate-pulse' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {cfg.label}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-fantom-text-muted">
            Render {r.id.slice(0, 8)}…
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => router.push(`/studio/shorts/${id}/preview`)}>
          ← Back
        </Button>
      </div>

      {error && (
        <div className="rounded-fantom border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Status card */}
      <div className="rounded-fantom border border-fantom-steel-border bg-fantom-steel/30 divide-y divide-fantom-steel-border">
        <div className="grid grid-cols-2 gap-0 divide-x divide-fantom-steel-border">
          <div className="px-4 py-3">
            <span className="block text-xs text-fantom-text-muted">Status</span>
            <span className="mt-0.5 text-sm font-medium text-fantom-text capitalize">{r.status}</span>
          </div>
          <div className="px-4 py-3">
            <span className="block text-xs text-fantom-text-muted">Duration</span>
            <span className="mt-0.5 text-sm font-medium text-fantom-text">{fmtMs(r.durationMs)}</span>
          </div>
        </div>
        {r.startedAt && (
          <div className="px-4 py-3">
            <span className="block text-xs text-fantom-text-muted">Started</span>
            <span className="mt-0.5 text-sm text-fantom-text">
              {new Date(r.startedAt).toLocaleString()}
            </span>
          </div>
        )}
        {r.finishedAt && (
          <div className="px-4 py-3">
            <span className="block text-xs text-fantom-text-muted">Finished</span>
            <span className="mt-0.5 text-sm text-fantom-text">
              {new Date(r.finishedAt).toLocaleString()}
            </span>
          </div>
        )}
      </div>

      {/* Active state: spinner + cancel */}
      {isActive && (
        <div className="flex items-center gap-4 rounded-fantom border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <Spinner size="sm" />
          <span className="flex-1 text-sm text-amber-300">
            {r.status === 'queued' ? 'Waiting in queue…' : 'Rendering video…'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            disabled={cancelling}
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
        </div>
      )}

      {/* Completed: video player */}
      {r.status === 'completed' && r.outputUrl && (
        <div className="space-y-2">
          <p className="text-xs text-fantom-text-muted">Rendered output</p>
          <video
            src={r.outputUrl}
            controls
            className="w-full max-w-xs rounded-fantom border border-fantom-steel-border bg-black"
            style={{ aspectRatio: '9/16' }}
          />
        </div>
      )}

      {/* Failed: error message */}
      {r.status === 'failed' && r.errorMessage && (
        <div className="rounded-fantom border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <strong>Error:</strong> {r.errorMessage}
        </div>
      )}

      {/* Cancelled */}
      {r.status === 'cancelled' && (
        <div className="rounded-fantom border border-fantom-steel-border bg-fantom-steel/20 px-4 py-3 text-sm text-fantom-text-muted">
          Render was cancelled. The brief has been reset to Ready — you can generate again from the
          preview page.
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between pb-8">
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => router.push(`/studio/shorts/${id}/preview`)}
          >
            Back to Preview
          </Button>
          {canDelete && (
            <Button
              variant="danger"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canTryAgain && (
            <Button
              variant="primary"
              size="sm"
              onClick={handleTryAgain}
              disabled={unlocking}
            >
              {unlocking ? 'Resetting…' : 'Try Again'}
            </Button>
          )}
          {r.status === 'completed' && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => router.push('/studio/shorts')}
            >
              Back to Briefs
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
