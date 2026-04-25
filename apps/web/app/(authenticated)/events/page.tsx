'use client'

import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '../../../src/lib/api-client'
import { Badge, Button, Card, Spinner } from '@fantom/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

type EventSeverity = 'debug' | 'info' | 'warn'

interface TenantEvent {
  id: string
  kind: string
  severity: EventSeverity
  subjectType: string | null
  subjectId: string | null
  metadata: Record<string, unknown>
  errorMessage: string | null
  createdAt: string
}

interface EventsResponse {
  events: TenantEvent[]
  nextCursor: string | null
}

// ── Severity badge ────────────────────────────────────────────────────────────

const SEVERITY_COLORS: Record<EventSeverity, string> = {
  debug: 'bg-fantom-steel text-fantom-text-muted',
  info: 'bg-blue-900/40 text-blue-300',
  warn: 'bg-yellow-900/40 text-yellow-300',
}

function SeverityBadge({ severity }: { severity: EventSeverity }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${SEVERITY_COLORS[severity]}`}
    >
      {severity}
    </span>
  )
}

// ── Kind badge ────────────────────────────────────────────────────────────────

function kindColor(kind: string): string {
  if (kind.startsWith('job.')) return 'bg-purple-900/40 text-purple-300'
  if (kind.startsWith('distribution.')) return 'bg-cyan-900/40 text-cyan-300'
  if (kind.startsWith('asset.')) return 'bg-green-900/40 text-green-300'
  if (kind.startsWith('voice.')) return 'bg-orange-900/40 text-orange-300'
  if (kind.startsWith('auth.')) return 'bg-slate-700 text-slate-300'
  return 'bg-fantom-steel text-fantom-text-muted'
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono ${kindColor(kind)}`}
    >
      {kind}
    </span>
  )
}

// ── Event row ─────────────────────────────────────────────────────────────────

function EventRow({ event }: { event: TenantEvent }) {
  const [expanded, setExpanded] = useState(false)
  const hasDetail =
    event.errorMessage ||
    (event.metadata && Object.keys(event.metadata).length > 0) ||
    event.subjectType

  return (
    <div className="border-b border-fantom-steel-border last:border-b-0">
      <div
        className={`flex items-start gap-3 px-4 py-3 text-sm ${hasDetail ? 'cursor-pointer hover:bg-fantom-steel/30' : ''}`}
        onClick={() => hasDetail && setExpanded((x) => !x)}
      >
        <span className="w-36 shrink-0 font-mono text-xs text-fantom-text-muted">
          {new Date(event.createdAt).toLocaleTimeString()}
        </span>
        <SeverityBadge severity={event.severity} />
        <KindBadge kind={event.kind} />
        {event.subjectType && (
          <span className="text-fantom-text-muted text-xs">
            {event.subjectType}
            {event.subjectId ? ` · ${event.subjectId.slice(-8)}` : ''}
          </span>
        )}
        {event.errorMessage && (
          <span className="text-yellow-400 text-xs truncate max-w-xs">{event.errorMessage}</span>
        )}
        {hasDetail && (
          <span className="ml-auto text-fantom-text-muted text-xs">{expanded ? '▲' : '▼'}</span>
        )}
      </div>
      {expanded && hasDetail && (
        <div className="px-4 pb-3">
          {event.errorMessage && (
            <p className="mb-2 text-xs text-yellow-400 font-mono">{event.errorMessage}</p>
          )}
          {Object.keys(event.metadata).length > 0 && (
            <pre className="rounded bg-fantom-steel p-3 text-xs text-fantom-text-muted overflow-auto max-h-48">
              {JSON.stringify(event.metadata, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// ── Kind filter ───────────────────────────────────────────────────────────────

const KIND_PREFIXES = ['all', 'job', 'distribution', 'asset', 'voice', 'auth']

// ── Page ──────────────────────────────────────────────────────────────────────

export default function EventsPage() {
  const [events, setEvents] = useState<TenantEvent[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState<string>('all')

  const fetchEvents = useCallback(
    async (cursor?: string) => {
      const params = new URLSearchParams({ limit: '50' })
      if (cursor) params.set('cursor', cursor)
      if (kindFilter !== 'all') params.set('kind_prefix', kindFilter)

      const data = await apiFetch<EventsResponse>(`/events?${params}`)
      return data
    },
    [kindFilter],
  )

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchEvents()
      .then(({ events: rows, nextCursor: nc }) => {
        setEvents(rows)
        setNextCursor(nc)
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load events'))
      .finally(() => setLoading(false))
  }, [fetchEvents])

  async function refresh() {
    setEvents([])
    setError(null)
    try {
      const { events: rows, nextCursor: nc } = await fetchEvents()
      setEvents(rows)
      setNextCursor(nc)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load events')
    }
  }

  async function loadMore() {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const { events: more, nextCursor: nc } = await fetchEvents(nextCursor)
      setEvents((prev) => [...prev, ...more])
      setNextCursor(nc)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more')
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-fantom-text">Events</h1>
          <p className="mt-1 text-sm text-fantom-text-muted">
            Activity log for your workspace — info and warnings only.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>

      {/* Kind filter */}
      <div className="flex flex-wrap gap-2">
        {KIND_PREFIXES.map((prefix) => (
          <button
            key={prefix}
            onClick={() => setKindFilter(prefix)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              kindFilter === prefix
                ? 'bg-fantom-blue text-white'
                : 'bg-fantom-steel text-fantom-text-muted hover:text-fantom-text'
            }`}
          >
            {prefix === 'all' ? 'All events' : prefix + '.*'}
          </button>
        ))}
      </div>

      {/* Events list */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : error ? (
        <Card className="p-6">
          <p className="text-red-400 text-sm">{error}</p>
        </Card>
      ) : events.length === 0 ? (
        <Card className="p-12 text-center">
          <p className="text-fantom-text-muted">No events yet.</p>
          <p className="mt-2 text-sm text-fantom-text-muted">
            Events are created when jobs, assets, distributions, and other actions happen in your workspace.
          </p>
        </Card>
      ) : (
        <Card className="divide-y divide-fantom-steel-border overflow-hidden p-0">
          {events.map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </Card>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Spinner size="sm" /> : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}
