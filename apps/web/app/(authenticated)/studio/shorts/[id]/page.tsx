'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch } from '../../../../../src/lib/api-client'
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

type ShortStatus =
  | 'draft'
  | 'rendering'
  | 'rendered'
  | 'approved'
  | 'scheduled'
  | 'posted'
  | 'failed'

interface ShortsJob {
  id: string
  status: ShortStatus
  vibe: string
  script: string | null
  captionText: string | null
  musicVibe: string | null
  targetDurationSeconds: number
  photoAssetIds: string[]
  outputAssetId: string | null
  outputVideoUrl: string | null
  renderJobId: string | null
  scheduledFor: string | null
  postedAt: string | null
  errorMessage: string | null
  brandKitId: string | null
  voiceCloneId: string | null
  createdAt: string
  updatedAt: string
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ShortStatus }) {
  const variant: 'success' | 'danger' | 'warning' | 'neutral' =
    status === 'posted' ? 'success' :
    status === 'failed' ? 'danger' :
    status === 'rendering' ? 'warning' :
    'neutral'
  const labels: Record<ShortStatus, string> = {
    draft: 'Draft',
    rendering: 'Rendering…',
    rendered: 'Ready to Review',
    approved: 'Approved',
    scheduled: 'Scheduled',
    posted: 'Posted',
    failed: 'Failed',
  }
  return <Badge variant={variant}>{labels[status]}</Badge>
}

// ── Render progress poller ────────────────────────────────────────────────────

interface RenderJob {
  id: string
  status: string
  progress: number
  errorMessage: string | null
}

function RenderProgress({ renderJobId }: { renderJobId: string }) {
  const [job, setJob] = useState<RenderJob | null>(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      while (!cancelled) {
        try {
          const r = await apiFetch<RenderJob>(`/jobs/${renderJobId}`)
          if (!cancelled) setJob(r)
          if (r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled') break
        } catch {
          // silent — parent polling will detect the final state
        }
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
    }

    void poll()
    return () => { cancelled = true }
  }, [renderJobId])

  if (!job) return null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-fantom-text-muted">Render progress</span>
        <span className="font-medium text-fantom-text">{job.progress}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-fantom-steel">
        <div
          className="h-full rounded-full bg-fantom-blue transition-all"
          style={{ width: `${job.progress}%` }}
        />
      </div>
      {job.errorMessage && (
        <p className="text-xs text-red-400">{job.errorMessage}</p>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ShortsPreviewPage() {
  const params = useParams()
  const router = useRouter()
  const id = typeof params['id'] === 'string' ? params['id'] : ''

  const [shortsJob, setShortsJob] = useState<ShortsJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Edit state
  const [editingCaption, setEditingCaption] = useState(false)
  const [captionDraft, setCaptionDraft] = useState('')
  const [editingScript, setEditingScript] = useState(false)
  const [scriptDraft, setScriptDraft] = useState('')

  // Action state
  const [approving, setApproving] = useState(false)
  const [posting, setPosting] = useState(false)
  const [reRendering, setReRendering] = useState(false)
  const [saving, setSaving] = useState(false)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Data fetching ───────────────────────────────────────────────────────────

  const fetchJob = useCallback(async () => {
    try {
      const r = await apiFetch<ShortsJob>(`/shorts/${id}`)
      setShortsJob(r)
      if (loading) setLoading(false)
      return r
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
      setLoading(false)
      return null
    }
  }, [id, loading])

  useEffect(() => {
    void fetchJob()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while rendering
  useEffect(() => {
    if (!shortsJob) return
    const isActive = shortsJob.status === 'rendering' || shortsJob.status === 'draft'

    if (isActive) {
      pollRef.current = setInterval(() => {
        void fetchJob()
      }, 4000)
    } else {
      if (pollRef.current) clearInterval(pollRef.current)
    }

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [shortsJob?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ─────────────────────────────────────────────────────────────────

  async function handleSaveCaption() {
    setSaving(true)
    try {
      const r = await apiFetch<ShortsJob>(`/shorts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ captionText: captionDraft, captionSource: 'custom' }),
      })
      setShortsJob(r)
      setEditingCaption(false)
    } catch (err) {
      setError(`Failed to save caption: ${err instanceof Error ? err.message : 'Try again'}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveScript() {
    setSaving(true)
    try {
      const r = await apiFetch<ShortsJob>(`/shorts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ script: scriptDraft, scriptSource: 'custom' }),
      })
      setShortsJob(r)
      setEditingScript(false)
    } catch (err) {
      setError(`Failed to save script: ${err instanceof Error ? err.message : 'Try again'}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleReRender() {
    setReRendering(true)
    setError(null)
    try {
      await apiFetch(`/shorts/${id}/render`, { method: 'POST' })
      const r = await fetchJob()
      if (r) setShortsJob(r)
    } catch (err) {
      setError(`Re-render failed: ${err instanceof Error ? err.message : 'Try again'}`)
    } finally {
      setReRendering(false)
    }
  }

  async function handleApprove() {
    setApproving(true)
    setError(null)
    try {
      const r = await apiFetch<ShortsJob>(`/shorts/${id}/approve`, { method: 'POST' })
      setShortsJob(r)
    } catch (err) {
      setError(`Approve failed: ${err instanceof Error ? err.message : 'Try again'}`)
    } finally {
      setApproving(false)
    }
  }

  async function handlePostNow() {
    if (!confirm('Post this short immediately?')) return
    setPosting(true)
    setError(null)
    try {
      const r = await apiFetch<ShortsJob>(`/shorts/${id}/post-now`, { method: 'POST' })
      setShortsJob(r)
    } catch (err) {
      setError(`Post failed: ${err instanceof Error ? err.message : 'Try again'}`)
    } finally {
      setPosting(false)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex min-h-[300px] items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!shortsJob) {
    return (
      <div className="flex min-h-[300px] items-center justify-center">
        <p className="text-fantom-text-muted">{error ?? 'Short not found'}</p>
      </div>
    )
  }

  const canEdit = ['draft', 'rendered', 'failed'].includes(shortsJob.status)
  const canRender = ['draft', 'rendered', 'failed'].includes(shortsJob.status)
  const canApprove = shortsJob.status === 'rendered'
  const canPostNow = ['rendered', 'approved', 'scheduled'].includes(shortsJob.status)
  const isRendering = shortsJob.status === 'rendering'

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-fantom-text">Short Preview</h1>
            <StatusBadge status={shortsJob.status} />
          </div>
          <p className="mt-1 text-sm text-fantom-text-muted">
            {shortsJob.vibe.replace(/_/g, ' ')} · {shortsJob.targetDurationSeconds}s target
            {shortsJob.scheduledFor && (
              <> · Scheduled for {new Date(shortsJob.scheduledFor).toLocaleString()}</>
            )}
          </p>
        </div>
        <Button variant="secondary" onClick={() => router.push('/studio/shorts')}>
          Back
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* ── Video preview ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Video</CardTitle>
        </CardHeader>
        <CardContent>
          {isRendering ? (
            <div className="space-y-4">
              <div className="flex aspect-[9/16] max-h-[400px] w-full max-w-[225px] mx-auto items-center justify-center rounded-xl bg-fantom-steel">
                <div className="text-center">
                  <Spinner size="lg" />
                  <p className="mt-3 text-sm text-fantom-text-muted">Rendering your short…</p>
                </div>
              </div>
              {shortsJob.renderJobId && (
                <RenderProgress renderJobId={shortsJob.renderJobId} />
              )}
            </div>
          ) : shortsJob.outputVideoUrl ? (
            <div className="flex justify-center">
              <video
                src={shortsJob.outputVideoUrl}
                controls
                playsInline
                className="max-h-[600px] max-w-[338px] w-full rounded-xl bg-black"
                style={{ aspectRatio: '9/16' }}
              />
            </div>
          ) : (
            <div className="flex aspect-[9/16] max-h-[400px] w-full max-w-[225px] mx-auto items-center justify-center rounded-xl bg-fantom-steel">
              <div className="text-center">
                <p className="text-sm text-fantom-text-muted">
                  {shortsJob.status === 'failed'
                    ? 'Render failed'
                    : 'No video yet — render to preview'}
                </p>
                {shortsJob.errorMessage && (
                  <p className="mt-2 text-xs text-red-400">{shortsJob.errorMessage}</p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Script ────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Script</CardTitle>
          {canEdit && !editingScript && (
            <button
              onClick={() => { setScriptDraft(shortsJob.script ?? ''); setEditingScript(true) }}
              className="text-xs text-fantom-blue hover:underline"
            >
              Edit
            </button>
          )}
        </CardHeader>
        <CardContent>
          {editingScript ? (
            <div className="space-y-3">
              <textarea
                value={scriptDraft}
                onChange={(e) => setScriptDraft(e.target.value)}
                rows={6}
                className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus:outline-none focus:ring-2 focus:ring-fantom-blue"
                autoFocus
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSaveScript} disabled={saving}>
                  {saving ? <Spinner size="sm" /> : 'Save'}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setEditingScript(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm text-fantom-text">
              {shortsJob.script ?? <span className="text-fantom-text-muted italic">No script</span>}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Caption ───────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Caption</CardTitle>
          {canEdit && !editingCaption && (
            <button
              onClick={() => { setCaptionDraft(shortsJob.captionText ?? ''); setEditingCaption(true) }}
              className="text-xs text-fantom-blue hover:underline"
            >
              Edit
            </button>
          )}
        </CardHeader>
        <CardContent>
          {editingCaption ? (
            <div className="space-y-3">
              <Input
                value={captionDraft}
                onChange={(e) => setCaptionDraft(e.target.value)}
                placeholder="Caption overlay text (≤12 words)..."
                autoFocus
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSaveCaption} disabled={saving}>
                  {saving ? <Spinner size="sm" /> : 'Save'}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setEditingCaption(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-fantom-text">
              {shortsJob.captionText ?? (
                <span className="text-fantom-text-muted italic">No caption</span>
              )}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Actions ───────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {canRender && !isRendering && (
              <Button variant="secondary" onClick={handleReRender} disabled={reRendering}>
                {reRendering ? (
                  <span className="flex items-center gap-2"><Spinner size="sm" /> Starting…</span>
                ) : (
                  shortsJob.status === 'draft' ? 'Render' : 'Re-render'
                )}
              </Button>
            )}

            {canApprove && (
              <Button onClick={handleApprove} disabled={approving}>
                {approving ? (
                  <span className="flex items-center gap-2"><Spinner size="sm" /> Scheduling…</span>
                ) : (
                  'Approve & Schedule'
                )}
              </Button>
            )}

            {canPostNow && (
              <Button
                variant="secondary"
                onClick={handlePostNow}
                disabled={posting}
              >
                {posting ? (
                  <span className="flex items-center gap-2"><Spinner size="sm" /> Posting…</span>
                ) : (
                  'Post Now'
                )}
              </Button>
            )}

            {shortsJob.status === 'scheduled' && (
              <p className="self-center text-sm text-fantom-text-muted">
                Scheduled for {new Date(shortsJob.scheduledFor!).toLocaleString()}
              </p>
            )}

            {shortsJob.status === 'posted' && (
              <p className="self-center text-sm text-green-400">
                Posted {shortsJob.postedAt ? new Date(shortsJob.postedAt).toLocaleString() : ''}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
