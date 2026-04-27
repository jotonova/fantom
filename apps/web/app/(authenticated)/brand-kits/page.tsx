'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../../src/lib/api-client'
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Spinner } from '@fantom/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BrandKit {
  id: string
  name: string
  isDefault: boolean
  logoAssetId: string | null
  logoUrl: string | null
  primaryColor: string | null
  secondaryColor: string | null
  accentColor: string | null
  headingFont: string | null
  bodyFont: string | null
  introBumperAssetId: string | null
  introBumperUrl: string | null
  outroBumperAssetId: string | null
  outroBumperUrl: string | null
  captionBgColor: string | null
  captionTextColor: string | null
  captionFont: string | null
  captionPosition: string | null
  musicVibe: string | null
  createdAt: string
}

interface BrandKitsResponse {
  brandKits: BrandKit[]
}

interface AssetUploadUrlResponse {
  uploadUrl: string
  key: string
}

interface AssetRegisterResponse {
  id: string
  publicUrl: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FONT_OPTIONS = ['Montserrat', 'Inter', 'Playfair Display', 'Lato', 'Raleway', 'Open Sans']
const MUSIC_VIBES = ['upbeat', 'calm', 'dramatic', 'inspirational', 'none']
const CAPTION_POSITIONS = ['top', 'center', 'bottom']

// ── Color swatch ──────────────────────────────────────────────────────────────

function ColorSwatch({ color }: { color: string | null }) {
  if (!color) return <span className="text-xs text-fantom-text-muted">—</span>
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-4 w-4 rounded-sm border border-fantom-steel-border"
        style={{ backgroundColor: color }}
      />
      <span className="text-xs font-mono text-fantom-text-muted">{color}</span>
    </span>
  )
}

// ── Upload helper ─────────────────────────────────────────────────────────────

async function uploadAsset(file: File): Promise<{ id: string; publicUrl: string }> {
  const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'image'

  const { uploadUrl, key } = await apiFetch<AssetUploadUrlResponse>('/assets/upload-url', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, mimeType: file.type, kind }),
  })

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', uploadUrl)
    xhr.setRequestHeader('Content-Type', file.type)
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`R2 PUT ${xhr.status}`)))
    xhr.onerror = () => reject(new Error('Network error'))
    xhr.send(file)
  })

  return apiFetch<AssetRegisterResponse>('/assets', {
    method: 'POST',
    body: JSON.stringify({
      key,
      filename: file.name,
      kind,
      mimeType: file.type,
      sizeBytes: file.size,
    }),
  })
}

// ── Brand kit modal ───────────────────────────────────────────────────────────

interface KitModalProps {
  kit?: BrandKit
  onClose: () => void
  onSaved: (kit: BrandKit) => void
}

function BrandKitModal({ kit, onClose, onSaved }: KitModalProps) {
  const isEdit = !!kit

  const [name, setName] = useState(kit?.name ?? '')
  const [primaryColor, setPrimaryColor] = useState(kit?.primaryColor ?? '#1A2B4A')
  const [secondaryColor, setSecondaryColor] = useState(kit?.secondaryColor ?? '#C9A84C')
  const [accentColor, setAccentColor] = useState(kit?.accentColor ?? '#E8EDF2')
  const [headingFont, setHeadingFont] = useState(kit?.headingFont ?? 'Montserrat')
  const [bodyFont, setBodyFont] = useState(kit?.bodyFont ?? 'Inter')
  const [captionBgColor, setCaptionBgColor] = useState(kit?.captionBgColor ?? '#000000')
  const [captionTextColor, setCaptionTextColor] = useState(kit?.captionTextColor ?? '#FFFFFF')
  const [captionFont, setCaptionFont] = useState(kit?.captionFont ?? 'Inter')
  const [captionPosition, setCaptionPosition] = useState(kit?.captionPosition ?? 'bottom')
  const [musicVibe, setMusicVibe] = useState(kit?.musicVibe ?? 'inspirational')

  const [logoAssetId, setLogoAssetId] = useState<string | null>(kit?.logoAssetId ?? null)
  const [logoUrl, setLogoUrl] = useState<string | null>(kit?.logoUrl ?? null)
  const [introBumperAssetId, setIntroBumperAssetId] = useState<string | null>(kit?.introBumperAssetId ?? null)
  const [outroBumperAssetId, setOutroBumperAssetId] = useState<string | null>(kit?.outroBumperAssetId ?? null)

  const [logoUploading, setLogoUploading] = useState(false)
  const [introUploading, setIntroUploading] = useState(false)
  const [outroUploading, setOutroUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const logoRef = useRef<HTMLInputElement>(null)
  const introRef = useRef<HTMLInputElement>(null)
  const outroRef = useRef<HTMLInputElement>(null)

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setLogoUploading(true)
    try {
      const asset = await uploadAsset(file)
      setLogoAssetId(asset.id)
      setLogoUrl(asset.publicUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Logo upload failed')
    } finally {
      setLogoUploading(false)
    }
  }

  async function handleBumperUpload(
    e: React.ChangeEvent<HTMLInputElement>,
    kind: 'intro' | 'outro',
  ) {
    const file = e.target.files?.[0]
    if (!file) return
    kind === 'intro' ? setIntroUploading(true) : setOutroUploading(true)
    try {
      const asset = await uploadAsset(file)
      kind === 'intro' ? setIntroBumperAssetId(asset.id) : setOutroBumperAssetId(asset.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bumper upload failed')
    } finally {
      kind === 'intro' ? setIntroUploading(false) : setOutroUploading(false)
    }
  }

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError(null)
    try {
      const body = {
        name: name.trim(),
        logoAssetId,
        primaryColor,
        secondaryColor,
        accentColor,
        headingFont,
        bodyFont,
        introBumperAssetId,
        outroBumperAssetId,
        captionBgColor,
        captionTextColor,
        captionFont,
        captionPosition,
        musicVibe,
      }
      const saved = isEdit
        ? await apiFetch<BrandKit>(`/brand-kits/${kit.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await apiFetch<BrandKit>('/brand-kits', { method: 'POST', body: JSON.stringify(body) })
      onSaved(saved)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-fantom border border-fantom-steel-border bg-fantom-steel-lighter shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-fantom-steel-border px-5 py-4">
          <h2 className="font-semibold text-fantom-text">
            {isEdit ? 'Edit Brand Kit' : 'New Brand Kit'}
          </h2>
          <button onClick={onClose} className="text-fantom-text-muted hover:text-fantom-text" aria-label="Close">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="kit-name">Kit name</Label>
            <Input id="kit-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Novacor Default" />
          </div>

          {/* Logo */}
          <div className="space-y-1.5">
            <Label>Logo</Label>
            <div className="flex items-center gap-3">
              {logoUrl && (
                <img src={logoUrl} alt="Logo preview" className="h-10 w-10 rounded object-contain border border-fantom-steel-border" />
              )}
              <Button size="sm" variant="ghost" onClick={() => logoRef.current?.click()} disabled={logoUploading}>
                {logoUploading ? <Spinner size="sm" /> : logoAssetId ? 'Replace logo' : 'Upload logo'}
              </Button>
              {logoAssetId && (
                <Button size="sm" variant="ghost" onClick={() => { setLogoAssetId(null); setLogoUrl(null) }}>
                  Remove
                </Button>
              )}
            </div>
            <input ref={logoRef} type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
          </div>

          {/* Colors */}
          <div className="space-y-2">
            <Label>Brand colors</Label>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Primary', value: primaryColor, set: setPrimaryColor },
                { label: 'Secondary', value: secondaryColor, set: setSecondaryColor },
                { label: 'Accent', value: accentColor, set: setAccentColor },
              ].map(({ label, value, set }) => (
                <div key={label} className="space-y-1">
                  <p className="text-xs text-fantom-text-muted">{label}</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={value}
                      onChange={(e) => set(e.target.value)}
                      className="h-8 w-8 cursor-pointer rounded border border-fantom-steel-border bg-transparent"
                    />
                    <input
                      type="text"
                      value={value}
                      onChange={(e) => set(e.target.value)}
                      maxLength={7}
                      className="w-24 rounded-fantom border border-fantom-steel-border bg-fantom-steel px-2 py-1 text-xs font-mono text-fantom-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fantom-blue"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Fonts */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Heading font', value: headingFont, set: setHeadingFont },
              { label: 'Body font', value: bodyFont, set: setBodyFont },
            ].map(({ label, value, set }) => (
              <div key={label} className="space-y-1.5">
                <Label>{label}</Label>
                <select
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fantom-blue"
                >
                  {FONT_OPTIONS.map((f) => <option key={f}>{f}</option>)}
                </select>
              </div>
            ))}
          </div>

          {/* Bumpers */}
          <div className="space-y-2">
            <Label>Bumpers</Label>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Intro', kind: 'intro' as const, id: introBumperAssetId, loading: introUploading, ref: introRef },
                { label: 'Outro', kind: 'outro' as const, id: outroBumperAssetId, loading: outroUploading, ref: outroRef },
              ].map(({ label, kind, id, loading, ref }) => (
                <div key={kind} className="space-y-1">
                  <p className="text-xs text-fantom-text-muted">{label}</p>
                  <Button size="sm" variant="ghost" onClick={() => ref.current?.click()} disabled={loading}>
                    {loading ? <Spinner size="sm" /> : id ? `${label} set ✓` : `Upload ${label.toLowerCase()}`}
                  </Button>
                  <input ref={ref} type="file" accept="video/*,image/*" className="hidden" onChange={(e) => void handleBumperUpload(e, kind)} />
                </div>
              ))}
            </div>
          </div>

          {/* Captions */}
          <div className="space-y-2">
            <Label>Caption style</Label>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <p className="text-xs text-fantom-text-muted">Background</p>
                <div className="flex items-center gap-2">
                  <input type="color" value={captionBgColor} onChange={(e) => setCaptionBgColor(e.target.value)} className="h-8 w-8 cursor-pointer rounded border border-fantom-steel-border bg-transparent" />
                  <span className="text-xs font-mono text-fantom-text-muted">{captionBgColor}</span>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-fantom-text-muted">Text color</p>
                <div className="flex items-center gap-2">
                  <input type="color" value={captionTextColor} onChange={(e) => setCaptionTextColor(e.target.value)} className="h-8 w-8 cursor-pointer rounded border border-fantom-steel-border bg-transparent" />
                  <span className="text-xs font-mono text-fantom-text-muted">{captionTextColor}</span>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-fantom-text-muted">Position</p>
                <select
                  value={captionPosition}
                  onChange={(e) => setCaptionPosition(e.target.value)}
                  className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-2 py-1.5 text-sm text-fantom-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fantom-blue"
                >
                  {CAPTION_POSITIONS.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs text-fantom-text-muted">Caption font</p>
              <select
                value={captionFont}
                onChange={(e) => setCaptionFont(e.target.value)}
                className="w-full rounded-fantom border border-fantom-steel-border bg-fantom-steel px-3 py-2 text-sm text-fantom-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fantom-blue"
              >
                {FONT_OPTIONS.map((f) => <option key={f}>{f}</option>)}
              </select>
            </div>
            {/* Preview strip */}
            <div
              className="relative flex h-14 items-end overflow-hidden rounded-[6px] border border-fantom-steel-border"
              style={{ background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)' }}
            >
              <div
                className="w-full px-3 py-1.5 text-sm"
                style={{
                  backgroundColor: captionBgColor,
                  color: captionTextColor,
                  fontFamily: captionFont,
                  position: captionPosition === 'top' ? 'absolute' : captionPosition === 'center' ? 'absolute' : 'static',
                  top: captionPosition === 'top' ? 0 : captionPosition === 'center' ? '50%' : undefined,
                  transform: captionPosition === 'center' ? 'translateY(-50%)' : undefined,
                }}
              >
                Caption preview — {captionPosition}
              </div>
            </div>
          </div>

          {/* Music vibe */}
          <div className="space-y-1.5">
            <Label>Music vibe</Label>
            <div className="flex flex-wrap gap-2">
              {MUSIC_VIBES.map((v) => (
                <button
                  key={v}
                  onClick={() => setMusicVibe(v)}
                  className={`rounded-full border px-3 py-1 text-xs capitalize transition-colors ${
                    musicVibe === v
                      ? 'border-fantom-blue bg-fantom-blue/20 text-fantom-blue'
                      : 'border-fantom-steel-border text-fantom-text-muted hover:border-fantom-text hover:text-fantom-text'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-fantom-steel-border px-5 py-4">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? <Spinner size="sm" /> : isEdit ? 'Save changes' : 'Create kit'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Kit card ──────────────────────────────────────────────────────────────────

interface KitCardProps {
  kit: BrandKit
  onEdit: (kit: BrandKit) => void
  onSetDefault: (id: string) => void
  onDelete: (id: string) => void
  settingDefault: string | null
  deleting: string | null
}

function KitCard({ kit, onEdit, onSetDefault, onDelete, settingDefault, deleting }: KitCardProps) {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-4">
        {/* Logo thumbnail */}
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-fantom-steel-border bg-fantom-steel">
          {kit.logoUrl ? (
            <img src={kit.logoUrl} alt="Logo" className="h-full w-full object-contain" />
          ) : (
            <span className="text-xl text-fantom-text-muted">🎨</span>
          )}
        </div>

        {/* Details */}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-fantom-text">{kit.name}</span>
            {kit.isDefault && <Badge variant="success">default</Badge>}
          </div>

          {/* Color swatches */}
          <div className="flex flex-wrap gap-3">
            {[
              { label: 'Primary', value: kit.primaryColor },
              { label: 'Secondary', value: kit.secondaryColor },
              { label: 'Accent', value: kit.accentColor },
            ].map(({ label, value }) => (
              <div key={label} className="flex items-center gap-1">
                <span className="text-xs text-fantom-text-muted">{label}:</span>
                <ColorSwatch color={value} />
              </div>
            ))}
          </div>

          {/* Fonts + vibe */}
          <div className="flex flex-wrap gap-3 text-xs text-fantom-text-muted">
            {kit.headingFont && <span>Heading: <span className="text-fantom-text">{kit.headingFont}</span></span>}
            {kit.bodyFont && <span>Body: <span className="text-fantom-text">{kit.bodyFont}</span></span>}
            {kit.musicVibe && <span>Vibe: <span className="text-fantom-text capitalize">{kit.musicVibe}</span></span>}
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 flex-col gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => onEdit(kit)}>Edit</Button>
          {!kit.isDefault && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onSetDefault(kit.id)}
              disabled={settingDefault === kit.id}
            >
              {settingDefault === kit.id ? <Spinner size="sm" /> : 'Set default'}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDelete(kit.id)}
            disabled={deleting === kit.id || kit.isDefault}
            className="text-red-400 hover:text-red-300"
          >
            {deleting === kit.id ? <Spinner size="sm" /> : 'Delete'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BrandKitsPage() {
  const [kits, setKits] = useState<BrandKit[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingKit, setEditingKit] = useState<BrandKit | undefined>(undefined)
  const [settingDefault, setSettingDefault] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<BrandKitsResponse>('/brand-kits')
      .then((data) => setKits(data.brandKits))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  function handleOpenCreate() {
    setEditingKit(undefined)
    setShowModal(true)
  }

  function handleOpenEdit(kit: BrandKit) {
    setEditingKit(kit)
    setShowModal(true)
  }

  const handleSaved = useCallback((saved: BrandKit) => {
    setKits((prev) => {
      const idx = prev.findIndex((k) => k.id === saved.id)
      return idx >= 0 ? prev.map((k) => (k.id === saved.id ? saved : k)) : [...prev, saved]
    })
  }, [])

  async function handleSetDefault(id: string) {
    setSettingDefault(id)
    try {
      const updated = await apiFetch<BrandKit>(`/brand-kits/${id}/set-default`, { method: 'POST' })
      setKits((prev) => prev.map((k) => ({ ...k, isDefault: k.id === id ? updated.isDefault : false })))
    } catch (err) {
      console.error(err)
    } finally {
      setSettingDefault(null)
    }
  }

  async function handleDelete(id: string) {
    const kit = kits.find((k) => k.id === id)
    if (!kit) return
    if (!confirm(`Delete "${kit.name}"?`)) return
    setDeleting(id)
    try {
      await apiFetch(`/brand-kits/${id}`, { method: 'DELETE' })
      setKits((prev) => prev.filter((k) => k.id !== id))
    } catch (err) {
      console.error(err)
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-fantom-text">Brand Kits</h1>
          <p className="mt-1 text-sm text-fantom-text-muted">
            Visual identity applied to every video Fantom generates
          </p>
        </div>
        <Button onClick={handleOpenCreate}>New kit</Button>
      </div>

      {/* Kit list */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : kits.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No brand kits yet</CardTitle>
            <CardDescription>
              Create a brand kit to define your colors, fonts, bumpers, and caption style.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={handleOpenCreate}>Create your first kit</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {kits.map((kit) => (
            <KitCard
              key={kit.id}
              kit={kit}
              onEdit={handleOpenEdit}
              onSetDefault={(id) => void handleSetDefault(id)}
              onDelete={(id) => void handleDelete(id)}
              settingDefault={settingDefault}
              deleting={deleting}
            />
          ))}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <BrandKitModal
          kit={editingKit}
          onClose={() => setShowModal(false)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
