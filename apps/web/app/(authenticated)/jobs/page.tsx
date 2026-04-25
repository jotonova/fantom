'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../../src/lib/api-client'
import {
  Button,
  Card,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner,
} from '@fantom/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

type JobStatus = 'pending' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'

interface OutputAsset {
  id: string
  publicUrl: string
  originalFilename: string
}

interface RenderJob {
  id: string
  kind: string
  status: JobStatus
  progress: number
  errorMessage: string | null
  outputAsset: OutputAsset | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

interface VoiceClone {
  id: string
  name: string
  status: string
  providerVoiceId: string | null
}

interface ImageAsset {
  id: string
  originalFilename: string
  publicUrl: string
}

type BulkDeleteFilter = 'failed' | 'completed' | 'cancelled' | 'all-terminal'

type DeleteConfirm =
  | { kind: 'single'; id: string }
  | { kind: 'bulk'; filter: BulkDeleteFilter; count: number }

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<JobStatus, { bg: string; text: string; label: string }> = {
  pending:    { bg: 'bg-fantom-steel-border', text: 'text-fantom-text-muted', label: 'Pending' },
  queued:     { bg: 'bg-yellow-500/20',       text: 'text-yellow-400',        label: 'Queued' },
  processing: { bg: 'bg-blue-500/20',         text: 'text-blue-400',          label: 'Processing' },
  completed:  { bg: 'bg-green-500/20',        text: 'text-green-400',         label: 'Completed' },
  failed:     { bg: 'bg-red-500/20',          text: 'text-red-400',           label: 'Failed' },
  cancelled:  { bg: 'bg-fantom-steel-border', text: 'text-fantom-text-muted', label: 'Cancelled' },
}

function StatusBadge({ status }: { status: JobStatus }) {
  const { bg, text, label } = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${bg} ${text}`}
    >
      {label}
    </span>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-fantom-steel-border">
      <div
        className="h-full rounded-full bg-blue-500 transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  )
}

// ── Relative time ─────────────────────────────────────────────────────────────

function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    render_test_video: 'Test video',
    render_listing_video: 'Listing video',
    render_market_update: 'Market update',
    render_virtual_tour: 'Virtual tour',
    render_flip_video: 'Flip video',
    render_youtube_edit: 'YouTube edit',
  }
  return map[kind] ?? kind
}

// ── Job row ───────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled']

function JobRow({
  job,
  cancelling,
  onCancel,
  onRetry,
  onDelete,
}: {
  job: RenderJob
  cancelling: boolean
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [busy, setBusy] = useState(false)

  async function cancel() {
    setBusy(true)
    try { await onCancel(job.id) } finally { setBusy(false) }
  }

  async function retry() {
    setBusy(true)
    try { await onRetry(job.id) } finally { setBusy(false) }
  }

  const isCancellable = job.status === 'pending' || job.status === 'queued' || job.status === 'processing'
  const isTerminal = TERMINAL_STATUSES.includes(job.status)

  return (
    <div className="flex items-center gap-4 rounded-[6px] border border-fantom-steel-border bg-fantom-steel-lighter p-4">
      {/* ID + kind */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-fantom-text-muted">
            {job.id.slice(-8)}
          </span>
          <span className="text-sm text-fantom-text">{kindLabel(job.kind)}</span>
          {cancelling ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-fantom-steel-border px-2 py-0.5 text-xs font-medium text-fantom-text-muted">
              <Spinner size="sm" /> Cancelling…
            </span>
          ) : (
            <StatusBadge status={job.status} />
          )}
        </div>

        {/* Progress bar for processing jobs */}
        {job.status === 'processing' && !cancelling && (
          <div className="mt-2">
            <ProgressBar value={job.progress} />
            <p className="mt-1 text-xs text-fantom-text-muted">{job.progress}%</p>
          </div>
        )}

        {/* Error message for failed jobs */}
        {job.status === 'failed' && job.errorMessage && (
          <p className="mt-1 text-xs text-red-400">{job.errorMessage}</p>
        )}

        <p className="mt-1 text-xs text-fantom-text-muted">{relativeTime(job.createdAt)}</p>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-2">
        {job.status === 'completed' && job.outputAsset && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => window.open(job.outputAsset!.publicUrl, '_blank')}
          >
            View video
          </Button>
        )}
        {isCancellable && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void cancel()}
            disabled={busy || cancelling}
          >
            {busy ? <Spinner size="sm" /> : 'Cancel'}
          </Button>
        )}
        {job.status === 'failed' && (
          <Button size="sm" variant="ghost" onClick={() => void retry()} disabled={busy}>
            {busy ? <Spinner size="sm" /> : 'Retry'}
          </Button>
        )}
        {isTerminal && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDelete(job.id)}
            disabled={busy}
            className="text-fantom-text-muted/60 hover:text-red-400"
          >
            Delete
          </Button>
        )}
      </div>
    </div>
  )
}

// ── New job panel ─────────────────────────────────────────────────────────────

function NewJobPanel({ onCreated }: { onCreated: (job: RenderJob) => void }) {
  const [voices, setVoices] = useState<VoiceClone[]>([])
  const [images, setImages] = useState<ImageAsset[]>([])
  const [voiceId, setVoiceId] = useState('')
  const [imageId, setImageId] = useState('')
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void apiFetch<{ voices: VoiceClone[] }>('/voices')
      .then((d) => {
        const ready = d.voices.filter((v) => v.status === 'ready' && v.providerVoiceId)
        setVoices(ready)
        if (ready[0]) setVoiceId(ready[0].id)
      })
      .catch(console.error)

    void apiFetch<{ assets: ImageAsset[] }>('/assets?kind=image')
      .then((d) => {
        setImages(d.assets)
        if (d.assets[0]) setImageId(d.assets[0].id)
      })
      .catch(console.error)
  }, [])

  async function handleGenerate() {
    setError(null)
    if (!voiceId) { setError('Select a voice'); return }
    if (!imageId) { setError('Select an image'); return }
    if (!text.trim()) { setError('Enter a script'); return }

    setSubmitting(true)
    try {
      const job = await apiFetch<RenderJob>('/jobs', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'render_test_video',
          input: { voiceCloneId: voiceId, text: text.trim(), imageAssetId: imageId },
        }),
      })
      onCreated(job)
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create job')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-4 font-semibold text-fantom-text">New test video</h2>
      <div className="space-y-4">
        {/* Voice dropdown */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-fantom-text">Voice</label>
          {voices.length === 0 ? (
            <p className="text-sm text-fantom-text-muted">
              No ready voices — add one on the{' '}
              <a href="/voices" className="text-fantom-text underline">
                Voices
              </a>{' '}
              page.
            </p>
          ) : (
            <select
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fantom-blue"
            >
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Image dropdown */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-fantom-text">Background image</label>
          {images.length === 0 ? (
            <p className="text-sm text-fantom-text-muted">
              No images — upload one in the{' '}
              <a href="/library" className="text-fantom-text underline">
                Library
              </a>
              .
            </p>
          ) : (
            <select
              value={imageId}
              onChange={(e) => setImageId(e.target.value)}
              className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fantom-blue"
            >
              {images.map((img) => (
                <option key={img.id} value={img.id}>
                  {img.originalFilename}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Script textarea */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-fantom-text">Script</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={5000}
            rows={4}
            placeholder="Hello from Fantom — this is your first AI-generated video."
            className="w-full resize-none rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text placeholder:text-fantom-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fantom-blue"
          />
          <p className="text-right text-xs text-fantom-text-muted">{text.length}/5000</p>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <Button
          onClick={() => void handleGenerate()}
          disabled={submitting || !voiceId || !imageId || !text.trim()}
        >
          {submitting ? <Spinner size="sm" /> : 'Generate'}
        </Button>
      </div>
    </Card>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function JobsPage() {
  const [jobList, setJobList] = useState<RenderJob[]>([])
  const [loading, setLoading] = useState(true)
  const [cancellingIds, setCancellingIds] = useState<ReadonlySet<string>>(new Set())
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm | null>(null)
  const [confirming, setConfirming] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchJobs = useCallback(async () => {
    try {
      const data = await apiFetch<{ jobs: RenderJob[] }>('/jobs')
      setJobList(data.jobs)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchJobs()
    pollRef.current = setInterval(() => void fetchJobs(), 3000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [fetchJobs])

  function handleCreated(job: RenderJob) {
    setJobList((prev) => [job, ...prev])
  }

  async function handleCancel(id: string) {
    setCancellingIds((prev) => new Set([...prev, id]))
    try {
      await apiFetch(`/jobs/${id}/cancel`, { method: 'POST' })
      await fetchJobs()
    } finally {
      setCancellingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  async function handleRetry(id: string) {
    await apiFetch(`/jobs/${id}/retry`, { method: 'POST' })
    await fetchJobs()
  }

  function handleDeleteRequest(id: string) {
    setDeleteConfirm({ kind: 'single', id })
  }

  function handleBulkDeleteRequest(filter: BulkDeleteFilter) {
    const statuses: JobStatus[] =
      filter === 'all-terminal' ? ['completed', 'failed', 'cancelled'] : [filter as JobStatus]
    const count = jobList.filter((j) => statuses.includes(j.status)).length
    setDeleteConfirm({ kind: 'bulk', filter, count })
  }

  async function confirmDelete() {
    if (!deleteConfirm) return
    setConfirming(true)
    try {
      if (deleteConfirm.kind === 'single') {
        await apiFetch(`/jobs/${deleteConfirm.id}`, { method: 'DELETE' })
        setJobList((prev) => prev.filter((j) => j.id !== deleteConfirm.id))
      } else {
        await apiFetch<{ deletedCount: number }>('/jobs/bulk-delete', {
          method: 'POST',
          body: JSON.stringify({ status: deleteConfirm.filter }),
        })
        await fetchJobs()
      }
      setDeleteConfirm(null)
    } catch (err) {
      console.error(err)
    } finally {
      setConfirming(false)
    }
  }

  const terminalCount = jobList.filter((j) => TERMINAL_STATUSES.includes(j.status)).length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-fantom-text">Render Jobs</h1>
          <p className="mt-1 text-sm text-fantom-text-muted">
            Fantom&apos;s render pipeline — turning assets and voices into videos
          </p>
        </div>

        {/* Cleanup dropdown — only shown when there are terminal jobs */}
        {terminalCount > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="shrink-0 text-fantom-text-muted">
                Cleanup ▾
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => handleBulkDeleteRequest('failed')}
                disabled={jobList.filter((j) => j.status === 'failed').length === 0}
              >
                Clear failed jobs
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleBulkDeleteRequest('completed')}
                disabled={jobList.filter((j) => j.status === 'completed').length === 0}
              >
                Clear completed jobs
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handleBulkDeleteRequest('all-terminal')}>
                Clear all finished jobs
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* New job panel */}
      <NewJobPanel onCreated={handleCreated} />

      {/* Jobs list */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : jobList.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-fantom-text-muted">
            No jobs yet. Create your first test video above.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {jobList.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              cancelling={cancellingIds.has(job.id)}
              onCancel={(id) => void handleCancel(id)}
              onRetry={(id) => void handleRetry(id)}
              onDelete={handleDeleteRequest}
            />
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => !confirming && setDeleteConfirm(null)}
        >
          <div
            className="mx-4 w-full max-w-sm rounded-fantom border border-fantom-steel-border bg-fantom-steel p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-2 font-semibold text-fantom-text">
              {deleteConfirm.kind === 'single' ? 'Delete this job?' : `Delete ${deleteConfirm.count} job${deleteConfirm.count === 1 ? '' : 's'}?`}
            </h2>
            <p className="mb-6 text-sm text-fantom-text-muted">
              {deleteConfirm.kind === 'single'
                ? 'The rendered video (if any) will remain in your Library.'
                : `${deleteConfirm.count === 0 ? 'No' : deleteConfirm.count} job record${deleteConfirm.count === 1 ? '' : 's'} will be removed. Any rendered videos stay in your Library.`}
            </p>
            <div className="flex justify-end gap-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDeleteConfirm(null)}
                disabled={confirming}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void confirmDelete()}
                disabled={confirming || (deleteConfirm.kind === 'bulk' && deleteConfirm.count === 0)}
              >
                {confirming ? <Spinner size="sm" /> : 'Delete'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
