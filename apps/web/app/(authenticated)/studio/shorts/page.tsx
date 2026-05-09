'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch, ApiError } from '../../../../src/lib/api-client'
import { Badge, Button, Spinner } from '@fantom/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

type BriefStatus = 'draft' | 'ready' | 'rendering' | 'rendered' | 'failed'

interface ShortsBrief {
  id: string
  title: string
  durationSeconds: number
  status: BriefStatus
  sourceAssetIds: string[]
  createdAt: string
  updatedAt: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  BriefStatus,
  { variant: 'neutral' | 'success' | 'warning' | 'danger'; className?: string; label: string }
> = {
  draft:     { variant: 'neutral',  label: 'Draft' },
  ready:     { variant: 'neutral',  label: 'Ready', className: 'border-blue-800 bg-blue-950 text-blue-400' },
  rendering: { variant: 'warning',  label: 'Rendering', className: 'animate-pulse' },
  rendered:  { variant: 'success',  label: 'Rendered' },
  failed:    { variant: 'danger',   label: 'Failed' },
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ShortsBriefsPage() {
  const router = useRouter()
  const [briefs, setBriefs] = useState<ShortsBrief[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const r = await apiFetch<{ shortsBriefs: ShortsBrief[] }>('/shorts-briefs?limit=50')
      setBriefs(r.shortsBriefs ?? [])
    } catch {
      setError('Failed to load briefs')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(brief: ShortsBrief) {
    if (!confirm(`Delete "${brief.title}"? This cannot be undone.`)) return
    setDeleting(brief.id)
    try {
      await apiFetch(`/shorts-briefs/${brief.id}`, { method: 'DELETE' })
      setBriefs((prev) => prev.filter((b) => b.id !== brief.id))
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Delete failed')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-fantom-text">Shorts</h1>
          <p className="mt-0.5 text-sm text-fantom-text-muted">
            Create and manage your short video briefs.
          </p>
        </div>
        <Button variant="primary" onClick={() => router.push('/studio/shorts/new')}>
          + New Brief
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-fantom border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}{' '}
          <button onClick={load} className="underline">
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : briefs.length === 0 ? (
        <div className="rounded-fantom border border-dashed border-fantom-steel-border py-16 text-center">
          <p className="text-fantom-text-muted">No briefs yet.</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={() => router.push('/studio/shorts/new')}
          >
            Create your first brief
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-fantom border border-fantom-steel-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-fantom-steel-border bg-fantom-steel/60">
                <th className="px-4 py-3 text-left font-medium text-fantom-text-muted">Brief</th>
                <th className="px-4 py-3 text-left font-medium text-fantom-text-muted">Duration</th>
                <th className="px-4 py-3 text-left font-medium text-fantom-text-muted">Clips</th>
                <th className="px-4 py-3 text-left font-medium text-fantom-text-muted">Status</th>
                <th className="px-4 py-3 text-left font-medium text-fantom-text-muted">Created</th>
                <th className="px-4 py-3 text-right font-medium text-fantom-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-fantom-steel-border">
              {briefs.map((brief) => (
                <tr key={brief.id} className="bg-fantom-steel/20 hover:bg-fantom-steel/40 transition-colors">
                  <td className="px-4 py-3">
                    <span className="font-medium text-fantom-text">{brief.title}</span>
                  </td>
                  <td className="px-4 py-3 text-fantom-text-muted">{brief.durationSeconds}s</td>
                  <td className="px-4 py-3 text-fantom-text-muted">
                    {brief.sourceAssetIds.length} clip{brief.sourceAssetIds.length !== 1 ? 's' : ''}
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={STATUS_CONFIG[brief.status].variant}
                      className={STATUS_CONFIG[brief.status].className}
                    >
                      {STATUS_CONFIG[brief.status].label}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-fantom-text-muted">{relativeTime(brief.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => router.push(`/studio/shorts/${brief.id}/preview`)}
                      >
                        Preview
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => router.push(`/studio/shorts/${brief.id}/edit`)}
                      >
                        Edit
                      </Button>
                      {(brief.status === 'rendering' || brief.status === 'rendered') && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => router.push(`/studio/shorts/${brief.id}/render`)}
                        >
                          {brief.status === 'rendering' ? 'Watch' : 'View Render'}
                        </Button>
                      )}
                      {brief.status === 'draft' && (
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={deleting === brief.id}
                          onClick={() => handleDelete(brief)}
                        >
                          {deleting === brief.id ? '…' : 'Delete'}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
