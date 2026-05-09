'use client'

import { useEffect, useState } from 'react'
import { apiFetch } from '../../../../../src/lib/api-client'
import { Spinner } from '@fantom/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface VideoAsset {
  id: string
  originalFilename: string
  durationSeconds: string | null
  sceneCount: number | null
  thumbnailPublicUrl: string | null
  normalizedR2Key: string | null
  transcriptionStatus: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(seconds: string | null): string {
  if (!seconds) return '—'
  const s = Math.round(Number(seconds))
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}:${rem.toString().padStart(2, '0')}`
}

// ── Component ─────────────────────────────────────────────────────────────────

interface SourceClipPickerProps {
  value: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}

export function SourceClipPicker({ value, onChange, disabled = false }: SourceClipPickerProps) {
  const [assets, setAssets] = useState<VideoAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    apiFetch<{ assets: VideoAsset[] }>('/assets?kind=video&source=upload&limit=100')
      .then((r) => {
        // Only show clips where normalization is complete
        const ready = (r.assets ?? []).filter((a) => a.normalizedR2Key !== null)
        setAssets(ready)
      })
      .catch(() => setError('Failed to load clips'))
      .finally(() => setLoading(false))
  }, [])

  function toggle(id: string) {
    if (disabled) return
    if (value.includes(id)) {
      onChange(value.filter((v) => v !== id))
    } else {
      onChange([...value, id])
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner size="md" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-fantom border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
        {error}
      </div>
    )
  }

  if (assets.length === 0) {
    return (
      <div className="rounded-fantom border border-fantom-steel-border bg-fantom-steel/40 px-4 py-8 text-center text-sm text-fantom-text-muted">
        No processed clips found. Upload and process videos in{' '}
        <a href="/library/videos" className="text-fantom-blue underline">
          Video Library
        </a>{' '}
        first.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-fantom-text-muted">{assets.length} clip{assets.length !== 1 ? 's' : ''} available</span>
        {value.length > 0 && (
          <span className="rounded-full bg-fantom-blue/20 px-2 py-0.5 text-xs font-medium text-fantom-blue">
            {value.length} selected
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {assets.map((asset) => {
          const selected = value.includes(asset.id)
          const order = selected ? value.indexOf(asset.id) + 1 : null

          return (
            <button
              key={asset.id}
              type="button"
              onClick={() => toggle(asset.id)}
              disabled={disabled}
              className={[
                'relative flex flex-col overflow-hidden rounded-fantom border text-left transition-all',
                'focus:outline-none focus:ring-2 focus:ring-fantom-blue focus:ring-offset-1',
                disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                selected
                  ? 'border-fantom-blue bg-fantom-blue/10 shadow-sm shadow-fantom-blue/20'
                  : 'border-fantom-steel-border bg-fantom-steel hover:border-fantom-blue/50',
              ].join(' ')}
            >
              {/* Thumbnail */}
              <div className="relative aspect-video w-full overflow-hidden bg-black/40">
                {asset.thumbnailPublicUrl ? (
                  <img
                    src={asset.thumbnailPublicUrl}
                    alt={asset.originalFilename}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <svg className="h-8 w-8 text-fantom-text-muted/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </div>
                )}

                {/* Selection indicator */}
                <div className={[
                  'absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 text-xs font-bold',
                  selected
                    ? 'border-fantom-blue bg-fantom-blue text-white'
                    : 'border-white/60 bg-black/40 text-transparent',
                ].join(' ')}>
                  {order ?? ''}
                </div>
              </div>

              {/* Metadata */}
              <div className="flex flex-col gap-0.5 p-2">
                <span className="truncate text-xs font-medium text-fantom-text" title={asset.originalFilename}>
                  {asset.originalFilename}
                </span>
                <div className="flex items-center gap-2 text-xs text-fantom-text-muted">
                  <span>{formatDuration(asset.durationSeconds)}</span>
                  {asset.sceneCount !== null && (
                    <span>{asset.sceneCount} scene{asset.sceneCount !== 1 ? 's' : ''}</span>
                  )}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {value.length > 0 && (
        <p className="text-xs text-fantom-text-muted">
          Clips will be assembled in the order selected. Click a selected clip to remove it.
        </p>
      )}
    </div>
  )
}
