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

type DestinationKind = 'webhook' | 'youtube' | 'facebook' | 'instagram' | 'mls'
type DistributionStatus =
  | 'pending'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'

interface OutputAsset {
  publicUrl: string
  originalFilename: string
}

interface DistributionRecord {
  id: string
  jobId: string
  destinationKind: DestinationKind
  config: Record<string, unknown>
  status: DistributionStatus
  externalId: string | null
  externalUrl: string | null
  responsePayload: Record<string, unknown> | null
  errorMessage: string | null
  retries: number
  maxRetries: number
  createdAt: string
  completedAt: string | null
  outputAsset: OutputAsset | null
}

interface AutoPublishEntry {
  kind: DestinationKind
  config: Record<string, unknown>
  on_kinds?: string[]
}

// ── Destination kind metadata ──────────────────────────────────────────────────

const KIND_META: Record<
  DestinationKind,
  { label: string; color: string; bg: string; comingSoon: boolean }
> = {
  webhook:   { label: 'Webhook',   color: 'text-slate-300',   bg: 'bg-slate-500/20',   comingSoon: false },
  youtube:   { label: 'YouTube',   color: 'text-red-400',     bg: 'bg-red-500/20',     comingSoon: true  },
  facebook:  { label: 'Facebook',  color: 'text-blue-400',    bg: 'bg-blue-500/20',    comingSoon: true  },
  instagram: { label: 'Instagram', color: 'text-purple-400',  bg: 'bg-purple-500/20',  comingSoon: true  },
  mls:       { label: 'MLS',       color: 'text-yellow-400',  bg: 'bg-yellow-500/20',  comingSoon: true  },
}

const ALL_KINDS: DestinationKind[] = ['webhook', 'youtube', 'facebook', 'instagram', 'mls']

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<DistributionStatus, { bg: string; text: string; label: string }> = {
  pending:    { bg: 'bg-fantom-steel-border', text: 'text-fantom-text-muted', label: 'Pending' },
  queued:     { bg: 'bg-yellow-500/20',       text: 'text-yellow-400',        label: 'Queued' },
  processing: { bg: 'bg-blue-500/20',         text: 'text-blue-400',          label: 'Processing' },
  completed:  { bg: 'bg-green-500/20',        text: 'text-green-400',         label: 'Completed' },
  failed:     { bg: 'bg-red-500/20',          text: 'text-red-400',           label: 'Failed' },
  cancelled:  { bg: 'bg-fantom-steel-border', text: 'text-fantom-text-muted', label: 'Cancelled' },
}

function StatusBadge({ status }: { status: DistributionStatus }) {
  const { bg, text, label } = STATUS_CONFIG[status]
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${bg} ${text}`}>
      {label}
    </span>
  )
}

function KindBadge({ kind }: { kind: DestinationKind }) {
  const { label, color, bg } = KIND_META[kind]
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${bg} ${color}`}>
      {label}
    </span>
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

// ── Payload modal ─────────────────────────────────────────────────────────────

function PayloadModal({
  dist,
  onClose,
}: {
  dist: DistributionRecord
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="mx-4 w-full max-w-lg rounded-fantom border border-fantom-steel-border bg-fantom-steel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold text-fantom-text">Distribution details</h2>
          <button onClick={onClose} className="text-fantom-text-muted hover:text-fantom-text">✕</button>
        </div>

        <div className="space-y-4 text-sm">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wider text-fantom-text-muted">Config</p>
            <pre className="overflow-auto rounded bg-fantom-steel-lighter p-3 text-xs text-fantom-text">
              {JSON.stringify(dist.config, null, 2)}
            </pre>
          </div>

          {dist.responsePayload && (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wider text-fantom-text-muted">Response</p>
              <pre className="overflow-auto rounded bg-fantom-steel-lighter p-3 text-xs text-fantom-text max-h-48">
                {JSON.stringify(dist.responsePayload, null, 2)}
              </pre>
            </div>
          )}

          {dist.errorMessage && (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wider text-red-400">Error</p>
              <p className="rounded bg-red-500/10 p-3 text-xs text-red-400">{dist.errorMessage}</p>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}

// ── Add destination modal ─────────────────────────────────────────────────────

function AddDestinationModal({
  onAdd,
  onClose,
}: {
  onAdd: (entry: AutoPublishEntry) => Promise<void>
  onClose: () => void
}) {
  const [kind, setKind] = useState<DestinationKind>('webhook')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const meta = KIND_META[kind]

  async function handleAdd() {
    setError(null)
    if (kind === 'webhook') {
      if (!webhookUrl.trim()) { setError('URL is required'); return }
      if (!webhookUrl.startsWith('https://')) { setError('URL must start with https://'); return }
    }
    setSaving(true)
    try {
      await onAdd({ kind, config: kind === 'webhook' ? { url: webhookUrl.trim() } : {} })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="mx-4 w-full max-w-md rounded-fantom border border-fantom-steel-border bg-fantom-steel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold text-fantom-text">Add auto-publish destination</h2>
          <button onClick={onClose} className="text-fantom-text-muted hover:text-fantom-text">✕</button>
        </div>

        {/* Kind selector */}
        <div className="mb-4">
          <label className="mb-1.5 block text-xs font-medium text-fantom-text-muted">Destination</label>
          <div className="flex flex-wrap gap-2">
            {ALL_KINDS.map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  kind === k
                    ? `${KIND_META[k].bg} ${KIND_META[k].color} ring-1 ring-current`
                    : 'bg-fantom-steel-border text-fantom-text-muted hover:text-fantom-text'
                }`}
              >
                {KIND_META[k].label}
              </button>
            ))}
          </div>
        </div>

        {/* Coming soon banner for non-webhook */}
        {meta.comingSoon && (
          <div className="mb-4 rounded bg-yellow-500/10 px-4 py-3 text-sm text-yellow-400">
            {meta.label} publishing is coming soon. You can save this configuration now — it will
            activate when the integration ships.
          </div>
        )}

        {/* Webhook config */}
        {kind === 'webhook' && (
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-fantom-text-muted">
              Webhook URL <span className="text-red-400">*</span>
            </label>
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://hooks.your-domain.com/fantom"
              className="w-full rounded-[6px] border border-fantom-steel-border bg-fantom-steel-lighter px-3 py-2 text-sm text-fantom-text placeholder-fantom-text-muted focus:border-fantom-blue focus:outline-none"
            />
            <p className="mt-1 text-xs text-fantom-text-muted">Must be HTTPS. Fantom will POST a JSON payload when each job completes.</p>
          </div>
        )}

        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-3">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={() => void handleAdd()} disabled={saving}>
            {saving ? <Spinner size="sm" /> : 'Add destination'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Auto-publish settings panel ───────────────────────────────────────────────

function AutoPublishPanel() {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<AutoPublishEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddModal, setShowAddModal] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void apiFetch<{ auto_publish: AutoPublishEntry[] }>('/tenant-settings/distribution')
      .then((d) => setEntries(d.auto_publish))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  async function saveEntries(next: AutoPublishEntry[]) {
    setSaving(true)
    try {
      const data = await apiFetch<{ auto_publish: AutoPublishEntry[] }>(
        '/tenant-settings/distribution',
        { method: 'PUT', body: JSON.stringify({ auto_publish: next }) },
      )
      setEntries(data.auto_publish)
    } catch (err) {
      console.error('Failed to save auto-publish settings:', err)
    } finally {
      setSaving(false)
    }
  }

  async function handleAdd(entry: AutoPublishEntry) {
    await saveEntries([...entries, entry])
  }

  async function handleRemove(idx: number) {
    await saveEntries(entries.filter((_, i) => i !== idx))
  }

  return (
    <Card className="overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between p-5 text-left"
      >
        <div>
          <h2 className="font-semibold text-fantom-text">Auto-publish settings</h2>
          <p className="mt-0.5 text-sm text-fantom-text-muted">
            {loading
              ? 'Loading…'
              : entries.length === 0
              ? 'No destinations configured — videos stay in Library only'
              : `${entries.length} destination${entries.length === 1 ? '' : 's'} active`}
          </p>
        </div>
        <span className="text-fantom-text-muted">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-fantom-steel-border px-5 pb-5 pt-4">
          {loading ? (
            <div className="flex justify-center py-4">
              <Spinner size="sm" />
            </div>
          ) : (
            <div className="space-y-2">
              {entries.length === 0 && (
                <p className="py-2 text-sm text-fantom-text-muted">
                  No destinations yet. Add one below.
                </p>
              )}
              {entries.map((entry, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between rounded-[6px] border border-fantom-steel-border bg-fantom-steel px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <KindBadge kind={entry.kind} />
                    <span className="text-sm text-fantom-text-muted">
                      {entry.kind === 'webhook'
                        ? (entry.config['url'] as string | undefined)?.slice(0, 50) ?? '—'
                        : 'Config saved'}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleRemove(idx)}
                    disabled={saving}
                    className="text-fantom-text-muted/60 hover:text-red-400"
                  >
                    Remove
                  </Button>
                </div>
              ))}

              <Button size="sm" variant="ghost" onClick={() => setShowAddModal(true)}>
                + Add destination
              </Button>
            </div>
          )}
        </div>
      )}

      {showAddModal && (
        <AddDestinationModal
          onAdd={handleAdd}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </Card>
  )
}

// ── Distribution row ──────────────────────────────────────────────────────────

function DistributionRow({
  dist,
  onCancel,
  onRetry,
  onDelete,
}: {
  dist: DistributionRecord
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [payloadOpen, setPayloadOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const isCancellable = dist.status === 'pending' || dist.status === 'queued'
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(dist.status)

  return (
    <div className="flex items-center gap-4 rounded-[6px] border border-fantom-steel-border bg-fantom-steel-lighter p-4">
      {/* Kind + status + metadata */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <KindBadge kind={dist.destinationKind} />
          <StatusBadge status={dist.status} />
          <span className="font-mono text-xs text-fantom-text-muted">
            job {dist.jobId.slice(-8)}
          </span>
        </div>

        {dist.status === 'failed' && dist.errorMessage && (
          <p className="mt-1 text-xs text-red-400 truncate">{dist.errorMessage}</p>
        )}

        {dist.externalId && (
          <p className="mt-1 text-xs text-fantom-text-muted">id: {dist.externalId}</p>
        )}

        <p className="mt-1 text-xs text-fantom-text-muted">{relativeTime(dist.createdAt)}</p>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-2">
        {dist.externalUrl && dist.status === 'completed' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => window.open(dist.externalUrl!, '_blank')}
          >
            View ↗
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPayloadOpen(true)}
          className="text-fantom-text-muted"
        >
          Details
        </Button>
        {isCancellable && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => { setBusy(true); try { await onCancel(dist.id) } finally { setBusy(false) } }}
            disabled={busy}
          >
            {busy ? <Spinner size="sm" /> : 'Cancel'}
          </Button>
        )}
        {dist.status === 'failed' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => { setBusy(true); try { await onRetry(dist.id) } finally { setBusy(false) } }}
            disabled={busy}
          >
            {busy ? <Spinner size="sm" /> : 'Retry'}
          </Button>
        )}
        {isTerminal && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDelete(dist.id)}
            disabled={busy}
            className="text-fantom-text-muted/60 hover:text-red-400"
          >
            Delete
          </Button>
        )}
      </div>

      {payloadOpen && <PayloadModal dist={dist} onClose={() => setPayloadOpen(false)} />}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DistributionsPage() {
  const [distList, setDistList] = useState<DistributionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { kind: 'single'; id: string }
    | { kind: 'bulk'; filter: string; count: number }
    | null
  >(null)
  const [confirming, setConfirming] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchDistributions = useCallback(async () => {
    try {
      const data = await apiFetch<{ distributions: DistributionRecord[] }>('/distributions')
      setDistList(data.distributions)
    } catch (err) {
      console.error('Failed to fetch distributions:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchDistributions()
    pollRef.current = setInterval(() => void fetchDistributions(), 5000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [fetchDistributions])

  async function handleCancel(id: string) {
    await apiFetch(`/distributions/${id}/cancel`, { method: 'POST' })
    await fetchDistributions()
  }

  async function handleRetry(id: string) {
    await apiFetch(`/distributions/${id}/retry`, { method: 'POST' })
    await fetchDistributions()
  }

  function handleDeleteRequest(id: string) {
    setDeleteConfirm({ kind: 'single', id })
  }

  function handleBulkDeleteRequest(filter: string) {
    const matching = distList.filter((d) => {
      if (filter === 'all-terminal') return ['completed', 'failed', 'cancelled'].includes(d.status)
      return d.status === filter
    })
    setDeleteConfirm({ kind: 'bulk', filter, count: matching.length })
  }

  async function confirmDelete() {
    if (!deleteConfirm) return
    setConfirming(true)
    try {
      if (deleteConfirm.kind === 'single') {
        await apiFetch(`/distributions/${deleteConfirm.id}`, { method: 'DELETE' })
      } else {
        const toDelete = distList.filter((d) => {
          if (deleteConfirm.filter === 'all-terminal')
            return ['completed', 'failed', 'cancelled'].includes(d.status)
          return d.status === deleteConfirm.filter
        })
        await Promise.all(toDelete.map((d) => apiFetch(`/distributions/${d.id}`, { method: 'DELETE' })))
      }
      setDeleteConfirm(null)
      await fetchDistributions()
    } catch (err) {
      console.error('Delete failed:', err)
    } finally {
      setConfirming(false)
    }
  }

  const terminalCount = distList.filter((d) =>
    ['completed', 'failed', 'cancelled'].includes(d.status),
  ).length

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-fantom-text">Distributions</h1>
          <p className="mt-1 text-sm text-fantom-text-muted">
            Where Fantom&apos;s videos go after rendering
          </p>
        </div>

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
                disabled={distList.filter((d) => d.status === 'failed').length === 0}
              >
                Clear failed
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleBulkDeleteRequest('completed')}
                disabled={distList.filter((d) => d.status === 'completed').length === 0}
              >
                Clear completed
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handleBulkDeleteRequest('all-terminal')}>
                Clear all finished
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Auto-publish settings */}
      <AutoPublishPanel />

      {/* Distributions list */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : distList.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-fantom-text-muted">
            No distributions yet. Configure auto-publish above, or use the{' '}
            <strong className="text-fantom-text">Distribute</strong> button on any completed job.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {distList.map((dist) => (
            <DistributionRow
              key={dist.id}
              dist={dist}
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
              {deleteConfirm.kind === 'single'
                ? 'Delete this distribution record?'
                : `Delete ${deleteConfirm.count} record${deleteConfirm.count === 1 ? '' : 's'}?`}
            </h2>
            <p className="mb-6 text-sm text-fantom-text-muted">
              The distribution record will be removed. The rendered video stays in your Library.
            </p>
            <div className="flex justify-end gap-3">
              <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(null)} disabled={confirming}>
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
