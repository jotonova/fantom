'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, ApiError } from '../../../../src/lib/api-client'
import {
  estimateUploadCost,
  validateVideoFile,
  formatCostUsd,
} from '../../../../src/lib/uploadCostEstimate'
import { Badge, Button, Card, Spinner } from '@fantom/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface VideoAsset {
  id: string
  kind: 'video'
  originalFilename: string
  mimeType: string
  sizeBytes: number
  r2Key: string
  publicUrl: string
  thumbnailPublicUrl: string | null
  width: number | null
  height: number | null
  durationSeconds: string | null
  transcriptionStatus: 'pending' | 'processing' | 'complete' | 'failed' | null
  transcriptText: string | null
  codec: string | null
  sceneCount: number | null
  preprocessedAt: string | null
  normalizedR2Key: string | null
  normalizedWidth: number | null
  normalizedHeight: number | null
  loudnessLufs: string | null
  createdAt: string
}

interface AssetsResponse {
  assets: VideoAsset[]
  nextCursor?: string
}

interface PendingFile {
  localId: string
  file: File
  /** true while HTMLVideoElement is reading metadata */
  probing: boolean
  duration: number | null
  width: number | null
  height: number | null
  /** Per-file validation errors (from client-side check) */
  errors: string[]
  costEstimate: ReturnType<typeof estimateUploadCost> | null
}

interface UploadItem {
  localId: string
  filename: string
  progress: number
  error: string | null
}

// ── Formatters ─────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Metadata probing ──────────────────────────────────────────────────────────

function probeVideoMetadata(file: File): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve({
        duration: isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
      })
    }
    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read video metadata'))
    }
    video.src = url
  })
}

// ── VideoDropZone ─────────────────────────────────────────────────────────────

function VideoDropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('video/'))
    if (files.length > 0) onFiles(files)
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
      aria-label="Upload video files"
      className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-fantom border-2 border-dashed p-10 text-center transition-colors ${
        dragging
          ? 'border-fantom-blue-bright bg-fantom-blue/10'
          : 'border-fantom-steel-border hover:border-fantom-blue/40 hover:bg-fantom-steel-lighter'
      }`}
    >
      {/* Video camera icon */}
      <svg className="h-10 w-10 text-fantom-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
      </svg>
      <div>
        <p className="font-medium text-fantom-text">Drop video files here</p>
        <p className="mt-1 text-sm text-fantom-text-muted">
          or click to browse · MP4, WebM, MOV · 1080p min · 20 GB max · 2 hr max
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="video/*"
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) onFiles(files)
          // Reset so same file can be re-selected
          e.target.value = ''
        }}
      />
    </div>
  )
}

// ── Preprocessing predicates ──────────────────────────────────────────────────
// Derived from actual preprocessing outputs — not transcriptionStatus, which
// is reserved for the 1A.7 transcription step and will read 'pending' on all
// preprocessed-but-not-yet-transcribed assets.

function isPreprocessComplete(a: VideoAsset): boolean {
  return (
    !!a.preprocessedAt &&
    !!a.thumbnailPublicUrl &&
    a.sceneCount != null &&
    (a.transcriptionStatus === 'complete' || a.transcriptionStatus === 'failed')
  )
}

function isPreprocessFailed(a: VideoAsset): boolean {
  return !a.preprocessedAt && a.transcriptionStatus === 'failed'
}

// ── VideoAssetCard ────────────────────────────────────────────────────────────

function VideoAssetCard({
  asset,
  onDelete,
  onReprocess,
}: {
  asset: VideoAsset
  onDelete: (id: string) => void
  onReprocess: (id: string) => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [reprocessing, setReprocessing] = useState(false)

  const duration = asset.durationSeconds != null ? Number(asset.durationSeconds) : null
  const resolution =
    asset.width && asset.height ? `${asset.width}×${asset.height}` : null

  const preprocessComplete = isPreprocessComplete(asset)
  const preprocessFailed = isPreprocessFailed(asset)

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm(`Delete "${asset.originalFilename}"?`)) return
    setDeleting(true)
    apiFetch(`/assets/${asset.id}`, { method: 'DELETE' })
      .then(() => onDelete(asset.id))
      .catch(() => setDeleting(false))
  }

  function handleReprocess(e: React.MouseEvent) {
    e.stopPropagation()
    setReprocessing(true)
    apiFetch(`/videos/${asset.id}/reprocess`, { method: 'POST' })
      .then(() => onReprocess(asset.id))
      .catch(console.error)
      .finally(() => setReprocessing(false))
  }

  return (
    <Card className="flex flex-col gap-3 p-3">
      {/* Thumbnail */}
      {asset.thumbnailPublicUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={asset.thumbnailPublicUrl}
          alt={asset.originalFilename}
          className="h-28 w-full rounded-[6px] object-cover"
        />
      ) : (
        <div className="relative flex h-28 items-center justify-center rounded-[6px] bg-fantom-steel">
          <svg className="h-8 w-8 text-fantom-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
          </svg>
          {!preprocessComplete && (
            <div className="absolute bottom-1.5 right-1.5">
              <Spinner size="sm" />
            </div>
          )}
        </div>
      )}

      {/* Metadata */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fantom-text" title={asset.originalFilename}>
          {asset.originalFilename}
        </p>

        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {preprocessComplete ? (
            <>
              {asset.codec && <Badge variant="neutral">{asset.codec.toUpperCase()}</Badge>}
              {asset.sceneCount != null && (
                <Badge variant="neutral">
                  {asset.sceneCount === 1 ? '1 scene' : `${asset.sceneCount} scenes`}
                </Badge>
              )}
              {asset.transcriptionStatus === 'complete' ? (
                <Badge variant="success" title={!asset.transcriptText ? 'Transcript complete (no speech detected)' : undefined}>Transcript ✓</Badge>
              ) : asset.transcriptionStatus === 'failed' ? (
                <Badge variant="danger">Transcript failed</Badge>
              ) : asset.transcriptionStatus === 'pending' ? (
                <Badge variant="neutral">Transcript queued</Badge>
              ) : null}
              {asset.normalizedR2Key ? (
                <Badge variant="success" title={[
                  asset.normalizedWidth && asset.normalizedHeight ? `${asset.normalizedWidth}×${asset.normalizedHeight}` : null,
                  asset.loudnessLufs ? `${parseFloat(asset.loudnessLufs).toFixed(1)} LUFS` : null,
                ].filter(Boolean).join(' • ') || 'Normalized'}>
                  Normalized ✓
                </Badge>
              ) : asset.preprocessedAt ? (
                <Badge variant="neutral">Normalize skipped</Badge>
              ) : null}
            </>
          ) : preprocessFailed ? (
            <Badge variant="danger">Preprocess failed</Badge>
          ) : asset.transcriptionStatus === 'processing' && asset.preprocessedAt ? (
            <>
              {asset.codec && <Badge variant="neutral">{asset.codec.toUpperCase()}</Badge>}
              {asset.sceneCount != null && (
                <Badge variant="neutral">
                  {asset.sceneCount === 1 ? '1 scene' : `${asset.sceneCount} scenes`}
                </Badge>
              )}
              <Badge variant="warning">Transcribing…</Badge>
            </>
          ) : (
            <Badge variant="warning">Preprocessing…</Badge>
          )}
          {resolution && <Badge variant="neutral">{resolution}</Badge>}
        </div>

        <div className="mt-1.5 flex gap-3 text-xs text-fantom-text-muted">
          {duration != null && <span>{formatDuration(duration)}</span>}
          <span>{formatBytes(asset.sizeBytes)}</span>
          <span>{formatDate(asset.createdAt)}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-1.5">
        {!preprocessComplete && (
          preprocessFailed ? (
            <Button size="sm" variant="secondary" onClick={handleReprocess} disabled={reprocessing} className="w-full">
              {reprocessing ? <Spinner size="sm" /> : 'Reprocess'}
            </Button>
          ) : (
            <button
              onClick={handleReprocess}
              disabled={reprocessing}
              className="text-center text-xs text-fantom-text-muted hover:text-fantom-text disabled:opacity-50"
            >
              {reprocessing ? 'Queuing…' : 'Force reprocess'}
            </button>
          )
        )}
        <Button size="sm" variant="danger" onClick={handleDelete} disabled={deleting} className="w-full">
          {deleting ? <Spinner size="sm" /> : 'Delete'}
        </Button>
      </div>
    </Card>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function VideoLibraryPage() {
  const [assetList, setAssetList] = useState<VideoAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loadingMore, setLoadingMore] = useState(false)

  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [uploading, setUploading] = useState(false)

  // ── Load existing videos ────────────────────────────────────────────────────

  async function loadVideos(cursor?: string) {
    const params = new URLSearchParams({ kind: 'video', limit: '50' })
    if (cursor) params.set('cursor', cursor)
    return apiFetch<AssetsResponse>(`/assets?${params}`)
  }

  useEffect(() => {
    setLoading(true)
    loadVideos()
      .then((data) => {
        setAssetList(data.assets as VideoAsset[])
        setNextCursor(data.nextCursor)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleLoadMore() {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const data = await loadVideos(nextCursor)
      setAssetList((prev) => [...prev, ...(data.assets as VideoAsset[])])
      setNextCursor(data.nextCursor)
    } finally {
      setLoadingMore(false)
    }
  }

  function handleDelete(id: string) {
    setAssetList((prev) => prev.filter((a) => a.id !== id))
  }

  function handleReprocess(id: string) {
    // Optimistically clear preprocessedAt so the spinner appears immediately
    setAssetList((prev) =>
      prev.map((a) => (a.id === id ? { ...a, preprocessedAt: null } : a)),
    )
  }

  // Polling: refresh every 5s while any asset is not fully preprocessed
  useEffect(() => {
    const hasInFlight = assetList.some((a) => !isPreprocessComplete(a))
    if (!hasInFlight) return

    const timer = setTimeout(async () => {
      try {
        const data = await loadVideos()
        setAssetList(data.assets as VideoAsset[])
        setNextCursor(data.nextCursor)
      } catch {
        // silently ignore poll errors
      }
    }, 5_000)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetList])

  // ── File probe + queue ──────────────────────────────────────────────────────

  const handleFiles = useCallback((files: File[]) => {
    for (const file of files) {
      const localId = crypto.randomUUID()

      // Add to pending immediately as probing
      setPendingFiles((prev) => [
        ...prev,
        {
          localId,
          file,
          probing: true,
          duration: null,
          width: null,
          height: null,
          errors: [],
          costEstimate: null,
        },
      ])

      // Probe metadata asynchronously
      probeVideoMetadata(file)
        .then(({ duration, width, height }) => {
          const errors: string[] = []
          const err = validateVideoFile(file, duration, width, height)
          if (err) errors.push(err)

          const costEstimate = errors.length === 0
            ? estimateUploadCost(duration, file.size)
            : null

          setPendingFiles((prev) =>
            prev.map((p) =>
              p.localId === localId
                ? { ...p, probing: false, duration, width, height, errors, costEstimate }
                : p,
            ),
          )
        })
        .catch(() => {
          setPendingFiles((prev) =>
            prev.map((p) =>
              p.localId === localId
                ? { ...p, probing: false, errors: ['Could not read video metadata — file may be corrupted.'] }
                : p,
            ),
          )
        })
    }
  }, [])

  function removePending(localId: string) {
    setPendingFiles((prev) => prev.filter((p) => p.localId !== localId))
  }

  // ── Upload ──────────────────────────────────────────────────────────────────

  const validPending = pendingFiles.filter((p) => !p.probing && p.errors.length === 0)
  const totalCost = validPending.reduce((sum, p) => sum + (p.costEstimate?.total ?? 0), 0)

  async function uploadFile(pending: PendingFile): Promise<VideoAsset | null> {
    const { localId, file, duration, width, height } = pending
    if (duration === null || width === null || height === null) return null

    // 1. Get presigned URL
    let r2Key: string
    let uploadUrl: string
    try {
      const res = await apiFetch<{ uploadUrl: string; r2Key: string; expiresAt: string }>(
        '/videos/upload-url',
        {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            durationSeconds: duration,
            width,
            height,
          }),
        },
      )
      r2Key = res.r2Key
      uploadUrl = res.uploadUrl
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to get upload URL'
      setUploads((prev) => prev.map((u) => u.localId === localId ? { ...u, error: msg } : u))
      return null
    }

    // 2. PUT directly to R2 (presigned URL — no auth header needed)
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', uploadUrl)
      xhr.setRequestHeader('Content-Type', file.type)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 90)
          setUploads((prev) => prev.map((u) => u.localId === localId ? { ...u, progress: pct } : u))
        }
      }
      xhr.onload = () => {
        if (xhr.status < 300) {
          resolve()
        } else {
          reject(new Error(`R2 upload failed: ${xhr.status}`))
        }
      }
      xhr.onerror = () => reject(new Error('Network error during upload'))
      xhr.send(file)
    }).catch((err: Error) => {
      setUploads((prev) => prev.map((u) => u.localId === localId ? { ...u, error: err.message } : u))
      throw err
    })

    // 3. Register in DB
    let asset: VideoAsset
    try {
      asset = await apiFetch<VideoAsset>('/videos', {
        method: 'POST',
        body: JSON.stringify({
          r2Key,
          originalFilename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          durationSeconds: duration,
          width,
          height,
        }),
      })
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to register video'
      setUploads((prev) => prev.map((u) => u.localId === localId ? { ...u, error: msg } : u))
      return null
    }

    setUploads((prev) => prev.map((u) => u.localId === localId ? { ...u, progress: 100 } : u))
    return asset
  }

  async function handleUpload() {
    if (validPending.length === 0 || uploading) return
    setUploading(true)

    // Move valid pending files to upload queue
    const toUpload = [...validPending]
    setPendingFiles((prev) => prev.filter((p) => !toUpload.some((t) => t.localId === p.localId)))
    setUploads((prev) => [
      ...prev,
      ...toUpload.map((p) => ({ localId: p.localId, filename: p.file.name, progress: 0, error: null })),
    ])

    const results = await Promise.allSettled(toUpload.map(uploadFile))

    // Optimistically prepend successful assets to the list
    const succeeded: VideoAsset[] = []
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        succeeded.push(result.value)
      }
    }
    if (succeeded.length > 0) {
      setAssetList((prev) => [...succeeded.reverse(), ...prev])
    }

    // Remove completed (non-errored) from upload queue after delay
    setTimeout(() => {
      setUploads((prev) => prev.filter((u) => u.error !== null && u.progress < 100))
    }, 2000)

    setUploading(false)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-fantom-text">Video Library</h1>
        <p className="mt-1 text-sm text-fantom-text-muted">
          Upload video clips for AI-edited Shorts, Long-form, and Episodic videos.
        </p>
      </div>

      {/* Drop zone */}
      <VideoDropZone onFiles={handleFiles} />

      {/* Pending files queue */}
      {pendingFiles.length > 0 && (
        <div className="space-y-2">
          {pendingFiles.map((p) => (
            <div
              key={p.localId}
              className="flex items-start gap-3 rounded-fantom border border-fantom-steel-border bg-fantom-steel-lighter px-4 py-3"
            >
              {p.probing ? (
                <Spinner size="sm" />
              ) : p.errors.length > 0 ? (
                <Badge variant="danger">Error</Badge>
              ) : (
                <Badge variant="neutral">Ready</Badge>
              )}

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fantom-text">{p.file.name}</p>
                {p.probing && (
                  <p className="mt-0.5 text-xs text-fantom-text-muted">Reading metadata…</p>
                )}
                {p.errors.length > 0 && (
                  <p className="mt-0.5 text-xs text-red-400">{p.errors[0]}</p>
                )}
                {!p.probing && p.errors.length === 0 && p.costEstimate && (
                  <p className="mt-0.5 text-xs text-fantom-text-muted">
                    {p.duration != null && formatDuration(p.duration)} ·{' '}
                    {formatBytes(p.file.size)} ·{' '}
                    {p.width}×{p.height} ·{' '}
                    est. {formatCostUsd(p.costEstimate.total)}/mo
                  </p>
                )}
              </div>

              <button
                onClick={() => removePending(p.localId)}
                className="shrink-0 text-xs text-fantom-text-muted hover:text-fantom-text"
                aria-label="Remove"
              >
                ✕
              </button>
            </div>
          ))}

          {/* Upload button */}
          {validPending.length > 0 && (
            <div className="flex items-center justify-between pt-1">
              <p className="text-sm text-fantom-text-muted">
                {validPending.length} file{validPending.length !== 1 ? 's' : ''} ready ·{' '}
                est. {formatCostUsd(totalCost)}/mo total
              </p>
              <Button onClick={() => void handleUpload()} disabled={uploading}>
                {uploading
                  ? 'Uploading…'
                  : `Upload ${validPending.length} file${validPending.length !== 1 ? 's' : ''}`}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Upload progress */}
      {uploads.length > 0 && (
        <div className="space-y-2">
          {uploads.map((u) => (
            <div
              key={u.localId}
              className="flex items-center gap-3 rounded-fantom border border-fantom-steel-border bg-fantom-steel-lighter px-4 py-2.5"
            >
              {u.error ? (
                <Badge variant="danger">Failed</Badge>
              ) : u.progress === 100 ? (
                <Badge variant="success">Done</Badge>
              ) : (
                <Spinner size="sm" />
              )}
              <span className="flex-1 truncate text-sm text-fantom-text">{u.filename}</span>
              {!u.error && u.progress < 100 && (
                <span className="text-xs text-fantom-text-muted">{u.progress}%</span>
              )}
              {u.error && <span className="text-xs text-red-400">{u.error}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Library grid */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : assetList.length === 0 && pendingFiles.length === 0 && uploads.length === 0 ? (
        <Card className="flex flex-col items-center gap-4 py-20 text-center">
          <svg className="h-12 w-12 text-fantom-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
          </svg>
          <div>
            <p className="font-medium text-fantom-text">No videos yet</p>
            <p className="mt-1 text-sm text-fantom-text-muted">Drop video files above to upload your first clip</p>
          </div>
        </Card>
      ) : assetList.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {assetList.map((asset) => (
              <VideoAssetCard key={asset.id} asset={asset} onDelete={handleDelete} onReprocess={handleReprocess} />
            ))}
          </div>
          {nextCursor && (
            <div className="flex justify-center pt-4">
              <Button variant="secondary" onClick={handleLoadMore} disabled={loadingMore}>
                {loadingMore ? <Spinner size="sm" /> : 'Load more'}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
