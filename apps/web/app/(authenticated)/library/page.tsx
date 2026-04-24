'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../../src/lib/api-client'
import { Badge, Button, Card, Spinner } from '@fantom/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

type AssetKind = 'image' | 'audio' | 'video' | 'document' | 'other'

interface Asset {
  id: string
  kind: AssetKind
  originalFilename: string
  mimeType: string
  sizeBytes: number
  r2Key: string
  publicUrl: string
  tags: string[]
  createdAt: string
}

interface AssetsResponse {
  assets: Asset[]
  nextCursor?: string
}

interface UploadUrlResponse {
  uploadUrl: string
  key: string
  expiresAt: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TABS: { label: string; kind: AssetKind | 'all' }[] = [
  { label: 'All', kind: 'all' },
  { label: 'Images', kind: 'image' },
  { label: 'Audio', kind: 'audio' },
  { label: 'Video', kind: 'video' },
  { label: 'Documents', kind: 'document' },
]

function kindFromMime(mime: string): AssetKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime.includes('pdf') || mime.includes('word') || mime.includes('text')) return 'document'
  return 'other'
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// ── Upload hook ───────────────────────────────────────────────────────────────

interface UploadItem {
  id: string
  filename: string
  progress: number
  error: string | null
}

function useUpload(onComplete: (asset: Asset) => void) {
  const [uploads, setUploads] = useState<UploadItem[]>([])

  const upload = useCallback(
    async (file: File) => {
      const uploadId = crypto.randomUUID()
      const kind = kindFromMime(file.type)

      setUploads((prev) => [
        ...prev,
        { id: uploadId, filename: file.name, progress: 0, error: null },
      ])

      try {
        // 1. Get presigned URL.
        const { uploadUrl, key } = await apiFetch<UploadUrlResponse>('/assets/upload-url', {
          method: 'POST',
          body: JSON.stringify({ filename: file.name, mimeType: file.type, kind }),
        })

        // 2. PUT to R2 with progress tracking.
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('PUT', uploadUrl)
          xhr.setRequestHeader('Content-Type', file.type)
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 90)
              setUploads((prev) =>
                prev.map((u) => (u.id === uploadId ? { ...u, progress: pct } : u)),
              )
            }
          }
          xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`R2 PUT failed: ${xhr.status}`)))
          xhr.onerror = () => reject(new Error('Network error'))
          xhr.send(file)
        })

        // 3. Register in DB.
        const asset = await apiFetch<Asset>('/assets', {
          method: 'POST',
          body: JSON.stringify({
            key,
            filename: file.name,
            kind,
            mimeType: file.type,
            sizeBytes: file.size,
          }),
        })

        setUploads((prev) =>
          prev.map((u) => (u.id === uploadId ? { ...u, progress: 100 } : u)),
        )
        onComplete(asset)

        // Remove after short delay.
        setTimeout(() => {
          setUploads((prev) => prev.filter((u) => u.id !== uploadId))
        }, 2000)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed'
        setUploads((prev) =>
          prev.map((u) => (u.id === uploadId ? { ...u, error: msg } : u)),
        )
      }
    },
    [onComplete],
  )

  return { uploads, upload }
}

// ── Asset card ─────────────────────────────────────────────────────────────────

function AssetCard({ asset, onDelete }: { asset: Asset; onDelete: (id: string) => void }) {
  const [deleting, setDeleting] = useState(false)
  const [copied, setCopied] = useState(false)

  async function handleDelete() {
    if (!confirm(`Delete "${asset.originalFilename}"?`)) return
    setDeleting(true)
    try {
      await apiFetch(`/assets/${asset.id}`, { method: 'DELETE' })
      onDelete(asset.id)
    } catch {
      setDeleting(false)
    }
  }

  function handleCopy() {
    void navigator.clipboard.writeText(asset.publicUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Card className="group relative flex flex-col gap-3 overflow-hidden p-3">
      {/* Preview */}
      <div className="relative flex h-36 items-center justify-center overflow-hidden rounded-[6px] bg-fantom-steel">
        {asset.kind === 'image' && (
          <img
            src={asset.publicUrl}
            alt={asset.originalFilename}
            className="h-full w-full object-cover"
          />
        )}
        {asset.kind === 'audio' && (
          <div className="w-full px-2">
            <audio controls className="w-full" src={asset.publicUrl} preload="none">
              <track kind="captions" />
            </audio>
          </div>
        )}
        {asset.kind === 'video' && (
          <video
            controls
            className="h-full w-full object-contain"
            src={asset.publicUrl}
            preload="metadata"
          />
        )}
        {(asset.kind === 'document' || asset.kind === 'other') && (
          <div className="flex flex-col items-center gap-2 text-fantom-text-muted">
            <svg className="h-10 w-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <span className="text-xs">Document</span>
          </div>
        )}

        {/* Hover actions */}
        <div className="absolute inset-0 flex items-end justify-end gap-1.5 bg-black/50 p-2 opacity-0 transition-opacity group-hover:opacity-100">
          <Button size="sm" variant="secondary" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy URL'}
          </Button>
          <Button size="sm" variant="danger" onClick={handleDelete} disabled={deleting}>
            {deleting ? <Spinner size="sm" /> : 'Delete'}
          </Button>
        </div>
      </div>

      {/* Meta */}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-fantom-text" title={asset.originalFilename}>
          {asset.originalFilename}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <Badge variant="neutral">{asset.kind}</Badge>
          <span className="text-xs text-fantom-text-muted">{formatBytes(asset.sizeBytes)}</span>
        </div>
      </div>
    </Card>
  )
}

// ── Drop zone ──────────────────────────────────────────────────────────────────

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
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
      aria-label="Upload files"
      className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-fantom border-2 border-dashed p-10 text-center transition-colors ${
        dragging
          ? 'border-fantom-blue-bright bg-fantom-blue/10'
          : 'border-fantom-steel-border hover:border-fantom-blue/40 hover:bg-fantom-steel-lighter'
      }`}
    >
      <svg
        className="h-10 w-10 text-fantom-text-muted"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
        />
      </svg>
      <div>
        <p className="font-medium text-fantom-text">Drop files here</p>
        <p className="mt-1 text-sm text-fantom-text-muted">or click to browse · Max 100 MB per file</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) onFiles(files)
        }}
      />
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LibraryPage() {
  const [activeTab, setActiveTab] = useState<AssetKind | 'all'>('all')
  const [assetList, setAssetList] = useState<Asset[]>([])
  const [loading, setLoading] = useState(true)
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loadingMore, setLoadingMore] = useState(false)

  const addAsset = useCallback((asset: Asset) => {
    setAssetList((prev) => [asset, ...prev])
  }, [])

  const { uploads, upload } = useUpload(addAsset)

  async function loadAssets(cursor?: string) {
    const params = new URLSearchParams()
    if (activeTab !== 'all') params.set('kind', activeTab)
    if (cursor) params.set('cursor', cursor)
    const qs = params.toString()
    const data = await apiFetch<AssetsResponse>(`/assets${qs ? `?${qs}` : ''}`)
    return data
  }

  useEffect(() => {
    setLoading(true)
    setAssetList([])
    setNextCursor(undefined)
    loadAssets()
      .then((data) => {
        setAssetList(data.assets)
        setNextCursor(data.nextCursor)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  async function handleLoadMore() {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const data = await loadAssets(nextCursor)
      setAssetList((prev) => [...prev, ...data.assets])
      setNextCursor(data.nextCursor)
    } finally {
      setLoadingMore(false)
    }
  }

  function handleDelete(id: string) {
    setAssetList((prev) => prev.filter((a) => a.id !== id))
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-fantom-text">Asset Library</h1>
        <p className="mt-1 text-sm text-fantom-text-muted">
          Logos, photos, audio, videos — Fantom&apos;s working materials
        </p>
      </div>

      {/* Drop zone */}
      <DropZone onFiles={(files) => files.forEach((f) => void upload(f))} />

      {/* Upload progress */}
      {uploads.length > 0 && (
        <div className="space-y-2">
          {uploads.map((u) => (
            <div
              key={u.id}
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
              {u.error && (
                <span className="text-xs text-red-400">{u.error}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 border-b border-fantom-steel-border">
        {TABS.map((tab) => (
          <button
            key={tab.kind}
            onClick={() => setActiveTab(tab.kind)}
            className={`px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fantom-blue ${
              activeTab === tab.kind
                ? 'border-b-2 border-fantom-blue-bright text-fantom-text'
                : 'text-fantom-text-muted hover:text-fantom-text'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Asset grid */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : assetList.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-fantom-text-muted">No assets yet. Drag files here to get started.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {assetList.map((asset) => (
              <AssetCard key={asset.id} asset={asset} onDelete={handleDelete} />
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
      )}
    </div>
  )
}
