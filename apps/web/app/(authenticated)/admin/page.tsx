'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../../src/lib/auth-store'
import { apiFetch } from '../../../src/lib/api-client'
import { Badge, Button, Card, Spinner } from '@fantom/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ServiceHealth {
  healthy: boolean
  latencyMs?: number
  error?: string
}

interface HealthResponse {
  healthy: boolean
  services: Record<string, ServiceHealth>
  timestamp: string
}

interface JobStatusCounts {
  pending: number
  queued: number
  processing: number
  completed: number
  failed: number
  cancelled: number
}

interface MetricsSnapshot {
  jobsByStatus: JobStatusCounts
  distributionsByStatus: JobStatusCounts
  avgRenderDurationSeconds: number | null
  errorRateLast24h: number | null
  elevenLabsCharsThisMonth: number
  r2StorageBytesUsed: number
  distinctActiveTenantsLast7d: number | null
}

interface AdminEvent {
  id: string
  tenantId: string | null
  kind: string
  severity: string
  subjectType: string | null
  subjectId: string | null
  metadata: Record<string, unknown>
  errorMessage: string | null
  createdAt: string
}

interface TenantSummary {
  id: string
  slug: string
  name: string
  jobsCompleted: number
  jobsFailed: number
  lastActivityAt: string | null
}

// ── Status chip ───────────────────────────────────────────────────────────────

function HealthDot({ healthy }: { healthy: boolean }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${healthy ? 'bg-green-400' : 'bg-red-500'}`}
    />
  )
}

function SeverityChip({ severity }: { severity: string }) {
  const colors: Record<string, string> = {
    debug: 'bg-slate-700 text-slate-300',
    info: 'bg-blue-900/40 text-blue-300',
    warn: 'bg-yellow-900/40 text-yellow-300',
    error: 'bg-red-900/40 text-red-300',
    critical: 'bg-red-700 text-white',
  }
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${colors[severity] ?? 'bg-slate-700 text-slate-300'}`}
    >
      {severity}
    </span>
  )
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

// ── Error detail modal ────────────────────────────────────────────────────────

interface EventDetailModalProps {
  eventId: string
  onClose: () => void
}

function EventDetailModal({ eventId, onClose }: EventDetailModalProps) {
  const [event, setEvent] = useState<AdminEvent & { errorStack?: string } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch<AdminEvent & { errorStack?: string }>(`/admin/events/${eventId}`)
      .then(setEvent)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [eventId])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="mx-4 w-full max-w-2xl rounded-xl bg-fantom-steel-lighter border border-fantom-steel-border p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-fantom-text">Event Detail</h3>
          <button
            onClick={onClose}
            className="text-fantom-text-muted hover:text-fantom-text text-xl leading-none"
          >
            ×
          </button>
        </div>
        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : event ? (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2 text-fantom-text-muted font-mono text-xs">
              <div>
                <span className="text-fantom-text-muted">ID </span>
                <span className="text-fantom-text">{event.id}</span>
              </div>
              <div>
                <span className="text-fantom-text-muted">Tenant </span>
                <span className="text-fantom-text">{event.tenantId ?? 'system'}</span>
              </div>
              <div>
                <span className="text-fantom-text-muted">Time </span>
                <span className="text-fantom-text">{new Date(event.createdAt).toISOString()}</span>
              </div>
              <div>
                <span className="text-fantom-text-muted">Kind </span>
                <span className="text-fantom-text">{event.kind}</span>
              </div>
            </div>
            {event.errorMessage && (
              <div>
                <p className="text-xs text-fantom-text-muted mb-1">Error</p>
                <p className="text-red-400 font-mono text-xs">{event.errorMessage}</p>
              </div>
            )}
            {event.errorStack && (
              <div>
                <p className="text-xs text-fantom-text-muted mb-1">Stack trace</p>
                <pre className="rounded bg-fantom-steel p-3 text-xs text-fantom-text-muted overflow-auto max-h-64">
                  {event.errorStack}
                </pre>
              </div>
            )}
            {Object.keys(event.metadata).length > 0 && (
              <div>
                <p className="text-xs text-fantom-text-muted mb-1">Metadata</p>
                <pre className="rounded bg-fantom-steel p-3 text-xs text-fantom-text-muted overflow-auto max-h-48">
                  {JSON.stringify(event.metadata, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ) : (
          <p className="text-red-400 text-sm">Event not found.</p>
        )}
      </div>
    </div>
  )
}

// ── Collapsible section ───────────────────────────────────────────────────────

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        onClick={() => setOpen((x) => !x)}
        className="flex w-full items-center justify-between rounded-lg px-1 py-2 text-left hover:bg-fantom-steel/30"
      >
        <h2 className="text-lg font-semibold text-fantom-text">{title}</h2>
        <span className="text-fantom-text-muted">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { tenant, isLoading: authLoading } = useAuth()
  const router = useRouter()

  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [errors, setErrors] = useState<AdminEvent[]>([])
  const [tenantList, setTenantList] = useState<TenantSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const isPlatformAdmin = tenant?.role === 'platform_admin'

  const loadAll = useCallback(async () => {
    try {
      const [h, m, e, t] = await Promise.all([
        apiFetch<HealthResponse>('/admin/health'),
        apiFetch<MetricsSnapshot>('/admin/metrics'),
        apiFetch<{ events: AdminEvent[] }>('/admin/events?severity=error&limit=20').then(
          (r) => r.events,
        ),
        apiFetch<{ tenants: TenantSummary[] }>('/admin/tenants').then((r) => r.tenants),
      ])
      setHealth(h)
      setMetrics(m)
      setErrors(e)
      setTenantList(t)
    } catch (err) {
      console.error('Admin load failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (authLoading) return
    if (!isPlatformAdmin) {
      router.replace('/dashboard')
      return
    }
    void loadAll()
    refreshTimer.current = setInterval(() => void loadAll(), 30_000)
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current)
    }
  }, [authLoading, isPlatformAdmin, loadAll, router])

  if (authLoading || (!isPlatformAdmin && !loading)) {
    return (
      <div className="flex min-h-96 items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  const totalJobs = metrics
    ? Object.values(metrics.jobsByStatus).reduce((a, b) => a + b, 0)
    : 0

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-fantom-text">Admin Dashboard</h1>
          <p className="mt-1 text-sm text-fantom-text-muted">Platform operator view — all tenants</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void loadAll()}>
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {/* 1. Health */}
          <Section title="Health">
            <Card className="p-0 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-fantom-steel-border bg-fantom-steel/30">
                    <th className="px-4 py-2 text-left text-xs text-fantom-text-muted font-medium">Service</th>
                    <th className="px-4 py-2 text-left text-xs text-fantom-text-muted font-medium">Status</th>
                    <th className="px-4 py-2 text-left text-xs text-fantom-text-muted font-medium">Latency</th>
                    <th className="px-4 py-2 text-left text-xs text-fantom-text-muted font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {health &&
                    Object.entries(health.services).map(([name, svc]) => (
                      <tr key={name} className="border-b border-fantom-steel-border last:border-b-0">
                        <td className="px-4 py-3 font-mono text-fantom-text capitalize">{name}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <HealthDot healthy={svc.healthy} />
                            <span
                              className={`text-xs ${svc.healthy ? 'text-green-400' : 'text-red-400'}`}
                            >
                              {svc.healthy ? 'Healthy' : 'Degraded'}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-fantom-text-muted">
                          {svc.latencyMs != null ? `${svc.latencyMs}ms` : '—'}
                        </td>
                        <td className="px-4 py-3 text-xs text-red-400">{svc.error ?? ''}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {health && (
                <p className="px-4 py-2 text-xs text-fantom-text-muted border-t border-fantom-steel-border">
                  Last checked {new Date(health.timestamp).toLocaleTimeString()}
                </p>
              )}
            </Card>
          </Section>

          {/* 2. Live Metrics */}
          <Section title="Live Metrics">
            {metrics && (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Card className="p-4">
                  <p className="text-xs text-fantom-text-muted">Jobs in-flight</p>
                  <p className="mt-1 text-3xl font-semibold text-fantom-text">
                    {metrics.jobsByStatus.processing + metrics.jobsByStatus.queued}
                  </p>
                  <p className="mt-1 text-xs text-fantom-text-muted">
                    {metrics.jobsByStatus.processing} processing · {metrics.jobsByStatus.queued} queued
                  </p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-fantom-text-muted">Success rate (24h)</p>
                  <p className="mt-1 text-3xl font-semibold text-fantom-text">
                    {metrics.errorRateLast24h != null
                      ? `${(100 - metrics.errorRateLast24h).toFixed(1)}%`
                      : '—'}
                  </p>
                  <p className="mt-1 text-xs text-fantom-text-muted">
                    {metrics.errorRateLast24h != null
                      ? `${metrics.errorRateLast24h}% error rate`
                      : 'No events yet'}
                  </p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-fantom-text-muted">Avg render (24h)</p>
                  <p className="mt-1 text-3xl font-semibold text-fantom-text">
                    {metrics.avgRenderDurationSeconds != null
                      ? `${metrics.avgRenderDurationSeconds}s`
                      : '—'}
                  </p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-fantom-text-muted">Active tenants (7d)</p>
                  <p className="mt-1 text-3xl font-semibold text-fantom-text">
                    {metrics.distinctActiveTenantsLast7d ?? '—'}
                  </p>
                </Card>
              </div>
            )}
          </Section>

          {/* 3. Job kind breakdown */}
          <Section title="Job Breakdown" defaultOpen={false}>
            {metrics && (
              <Card className="p-0 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-fantom-steel-border bg-fantom-steel/30">
                      <th className="px-4 py-2 text-left text-xs text-fantom-text-muted font-medium">Status</th>
                      <th className="px-4 py-2 text-right text-xs text-fantom-text-muted font-medium">Jobs</th>
                      <th className="px-4 py-2 text-right text-xs text-fantom-text-muted font-medium">Distributions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      ['completed', 'failed', 'processing', 'queued', 'pending', 'cancelled'] as const
                    ).map((s) => (
                      <tr key={s} className="border-b border-fantom-steel-border last:border-b-0">
                        <td className="px-4 py-2 capitalize text-fantom-text">{s}</td>
                        <td className="px-4 py-2 text-right font-mono text-fantom-text">
                          {formatNumber(metrics.jobsByStatus[s])}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-fantom-text">
                          {formatNumber(metrics.distributionsByStatus[s])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </Section>

          {/* 4. Cost Tracking */}
          <Section title="Cost Tracking" defaultOpen={false}>
            {metrics && (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Card className="p-4">
                  <p className="text-xs text-fantom-text-muted">ElevenLabs chars (this month)</p>
                  <p className="mt-1 text-2xl font-semibold text-fantom-text">
                    {formatNumber(metrics.elevenLabsCharsThisMonth)}
                  </p>
                  <p className="mt-1 text-xs text-fantom-text-muted">
                    Creator plan: 100k/mo included
                  </p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-fantom-text-muted">R2 storage used</p>
                  <p className="mt-1 text-2xl font-semibold text-fantom-text">
                    {formatBytes(metrics.r2StorageBytesUsed)}
                  </p>
                  <p className="mt-1 text-xs text-fantom-text-muted">Free tier: 10 GB</p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-fantom-text-muted">Total jobs (all time)</p>
                  <p className="mt-1 text-2xl font-semibold text-fantom-text">
                    {formatNumber(totalJobs)}
                  </p>
                </Card>
              </div>
            )}
          </Section>

          {/* 5. Recent Errors */}
          <Section title="Recent Errors">
            {errors.length === 0 ? (
              <Card className="p-6 text-center">
                <p className="text-green-400 text-sm">No recent errors. All clear.</p>
              </Card>
            ) : (
              <Card className="p-0 overflow-hidden">
                {errors.map((e) => (
                  <div
                    key={e.id}
                    className="flex cursor-pointer items-start gap-3 border-b border-fantom-steel-border px-4 py-3 text-sm last:border-b-0 hover:bg-fantom-steel/30"
                    onClick={() => setSelectedEventId(e.id)}
                  >
                    <span className="w-36 shrink-0 font-mono text-xs text-fantom-text-muted">
                      {new Date(e.createdAt).toLocaleTimeString()}
                    </span>
                    <SeverityChip severity={e.severity} />
                    <span className="font-mono text-xs text-fantom-text">{e.kind}</span>
                    {e.tenantId && (
                      <span className="text-xs text-fantom-text-muted">
                        tenant {e.tenantId.slice(-8)}
                      </span>
                    )}
                    {e.errorMessage && (
                      <span className="truncate text-xs text-red-400 max-w-xs">{e.errorMessage}</span>
                    )}
                    <span className="ml-auto text-xs text-fantom-text-muted">→</span>
                  </div>
                ))}
              </Card>
            )}
          </Section>

          {/* 6. Tenant Roster */}
          <Section title="Tenant Roster" defaultOpen={false}>
            <Card className="p-0 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-fantom-steel-border bg-fantom-steel/30">
                    <th className="px-4 py-2 text-left text-xs text-fantom-text-muted font-medium">Tenant</th>
                    <th className="px-4 py-2 text-right text-xs text-fantom-text-muted font-medium">Completed</th>
                    <th className="px-4 py-2 text-right text-xs text-fantom-text-muted font-medium">Failed</th>
                    <th className="px-4 py-2 text-left text-xs text-fantom-text-muted font-medium">Last Active</th>
                  </tr>
                </thead>
                <tbody>
                  {tenantList.map((t) => (
                    <tr key={t.id} className="border-b border-fantom-steel-border last:border-b-0">
                      <td className="px-4 py-3">
                        <p className="text-fantom-text font-medium">{t.name}</p>
                        <p className="text-xs text-fantom-text-muted">{t.slug}</p>
                      </td>
                      <td className="px-4 py-3 text-right text-green-400 font-mono">
                        {formatNumber(t.jobsCompleted)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        <span className={t.jobsFailed > 0 ? 'text-red-400' : 'text-fantom-text-muted'}>
                          {formatNumber(t.jobsFailed)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-fantom-text-muted">
                        {t.lastActivityAt
                          ? new Date(t.lastActivityAt).toLocaleString()
                          : 'No activity'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </Section>
        </>
      )}

      {selectedEventId && (
        <EventDetailModal eventId={selectedEventId} onClose={() => setSelectedEventId(null)} />
      )}
    </div>
  )
}
