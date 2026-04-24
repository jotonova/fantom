import { and, desc, eq, lt, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, assets, tenants } from '@fantom/db'
import type { Asset } from '@fantom/db'
import { generateUploadUrl, getPublicUrl, deleteObject, getObjectMetadata } from '@fantom/storage'
import { requireAuth } from '../plugins/auth.js'

// ── MIME validation ────────────────────────────────────────────────────────────

const ALLOWED_MIME: Record<string, readonly string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/aac', 'audio/flac'],
  video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/mpeg'],
  document: [
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  other: [],
}

const BLOCKED_MIME_PREFIXES = [
  'application/x-executable',
  'application/x-sh',
  'application/x-msdos-program',
  'application/x-msdownload',
  'application/x-bat',
]

function isBlockedMime(mimeType: string): boolean {
  return BLOCKED_MIME_PREFIXES.some((p) => mimeType.startsWith(p))
}

function isMimeAllowed(kind: string, mimeType: string): boolean {
  if (isBlockedMime(mimeType)) return false
  const list = ALLOWED_MIME[kind]
  if (!list) return false
  if (kind === 'other') return !isBlockedMime(mimeType)
  return list.includes(mimeType)
}

const MAX_BYTES = 100 * 1024 * 1024 // 100 MB

// ── Helpers ───────────────────────────────────────────────────────────────────

type AssetKind = 'image' | 'audio' | 'video' | 'document' | 'other'
const ASSET_KINDS: readonly AssetKind[] = ['image', 'audio', 'video', 'document', 'other']
function isAssetKind(v: unknown): v is AssetKind {
  return typeof v === 'string' && (ASSET_KINDS as readonly string[]).includes(v)
}

function withPublicUrl(asset: Asset): Asset & { publicUrl: string } {
  return { ...asset, publicUrl: getPublicUrl(asset.r2Key) }
}

async function getTenantSlug(tenantId: string): Promise<string | null> {
  // Set the GUC before querying — app_user has NOBYPASSRLS, so the tenants
  // table policy blocks reads when app.current_tenant_id is unset.
  const [row] = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    return tx.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  })
  return row?.slug ?? null
}

// ── Routes ────────────────────────────────────────────────────────────────────

const assetRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /assets/upload-url ────────────────────────────────────────────────────
  fastify.post<{
    Body: { filename: string; mimeType: string; kind: string }
  }>('/assets/upload-url', { preHandler: requireAuth }, async (request, reply) => {
    const { filename, mimeType, kind } = request.body ?? {}

    if (typeof filename !== 'string' || !filename.trim()) {
      return reply.code(400).send({ error: 'filename is required' })
    }
    if (typeof mimeType !== 'string' || !mimeType.trim()) {
      return reply.code(400).send({ error: 'mimeType is required' })
    }
    if (!isAssetKind(kind)) {
      return reply.code(400).send({ error: 'kind must be one of: image, audio, video, document, other' })
    }
    if (!isMimeAllowed(kind, mimeType)) {
      return reply.code(400).send({ error: `mimeType '${mimeType}' is not allowed for kind '${kind}'` })
    }

    const tenantId = request.tenantId!
    const slug = await getTenantSlug(tenantId)
    if (!slug) return reply.code(404).send({ error: 'Tenant not found' })

    const result = await generateUploadUrl(slug, kind, filename.trim(), mimeType)
    return reply.send(result)
  })

  // POST /assets ───────────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      key: string
      filename: string
      kind: string
      mimeType: string
      sizeBytes: number
      width?: number
      height?: number
      durationSeconds?: number
      tags?: string[]
    }
  }>('/assets', { preHandler: requireAuth }, async (request, reply) => {
    const { key, filename, kind, mimeType, sizeBytes, width, height, durationSeconds, tags } =
      request.body ?? {}

    if (typeof key !== 'string' || !key) return reply.code(400).send({ error: 'key is required' })
    if (typeof filename !== 'string' || !filename) return reply.code(400).send({ error: 'filename is required' })
    if (!isAssetKind(kind)) return reply.code(400).send({ error: 'invalid kind' })
    if (typeof mimeType !== 'string' || !mimeType) return reply.code(400).send({ error: 'mimeType is required' })
    if (typeof sizeBytes !== 'number' || sizeBytes <= 0) return reply.code(400).send({ error: 'sizeBytes must be a positive number' })
    if (sizeBytes > MAX_BYTES) return reply.code(400).send({ error: 'File exceeds 100 MB limit' })

    const tenantId = request.tenantId!
    const slug = await getTenantSlug(tenantId)
    if (!slug) return reply.code(404).send({ error: 'Tenant not found' })

    // Verify the key belongs to this tenant (prevents cross-tenant key spoofing).
    if (!key.startsWith(`${slug}/`)) {
      return reply.code(403).send({ error: 'Key does not belong to your tenant' })
    }

    // Verify the object actually landed in R2.
    try {
      const meta = await getObjectMetadata(key)
      if (meta.sizeBytes > MAX_BYTES) {
        return reply.code(400).send({ error: 'File exceeds 100 MB limit' })
      }
    } catch {
      return reply.code(422).send({ error: 'File not found in storage — upload may have failed' })
    }

    const userId = request.user!.id

    const asset = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx
        .insert(assets)
        .values({
          tenantId,
          uploadedByUserId: userId,
          kind,
          originalFilename: filename,
          mimeType,
          sizeBytes,
          r2Key: key,
          width: width ?? null,
          height: height ?? null,
          durationSeconds: durationSeconds != null ? String(durationSeconds) : null,
          tags: tags ?? [],
        })
        .returning()
      return row
    })

    if (!asset) return reply.code(500).send({ error: 'Failed to create asset' })
    return reply.code(201).send(withPublicUrl(asset))
  })

  // GET /assets ────────────────────────────────────────────────────────────────
  fastify.get<{
    Querystring: { kind?: string; tag?: string; limit?: string; cursor?: string }
  }>('/assets', { preHandler: requireAuth }, async (request, reply) => {
    const { kind, tag, cursor } = request.query
    const limit = Math.min(Number(request.query.limit ?? 50), 100)
    const tenantId = request.tenantId!

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)

      const conditions = [eq(assets.tenantId, tenantId)]

      if (isAssetKind(kind)) {
        conditions.push(eq(assets.kind, kind))
      }
      if (typeof tag === 'string' && tag) {
        conditions.push(sql`${assets.tags} @> ARRAY[${tag}]::text[]`)
      }
      if (typeof cursor === 'string' && cursor) {
        conditions.push(lt(assets.createdAt, new Date(cursor)))
      }

      return tx
        .select()
        .from(assets)
        .where(and(...conditions))
        .orderBy(desc(assets.createdAt))
        .limit(limit + 1)
    })

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const nextCursor =
      hasMore && page.length > 0
        ? page[page.length - 1]!.createdAt.toISOString()
        : undefined

    return reply.send({
      assets: page.map(withPublicUrl),
      nextCursor,
    })
  })

  // GET /assets/:id ────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/assets/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      const asset = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx.select().from(assets).where(eq(assets.id, id)).limit(1)
        return row
      })

      if (!asset) return reply.code(404).send({ error: 'Asset not found' })
      return reply.send(withPublicUrl(asset))
    },
  )

  // DELETE /assets/:id ─────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/assets/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      // 1. Fetch to confirm ownership and get r2Key.
      const asset = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx.select().from(assets).where(eq(assets.id, id)).limit(1)
        return row
      })

      if (!asset) return reply.code(404).send({ error: 'Asset not found' })

      // 2. Delete from DB (RLS ensures tenant scoping).
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        await tx.delete(assets).where(eq(assets.id, id))
      })

      // 3. Delete from R2 (best-effort — DB record is already gone).
      try {
        await deleteObject(asset.r2Key)
      } catch (err) {
        fastify.log.error(err, `R2 delete failed for key ${asset.r2Key} (orphaned)`)
      }

      return reply.code(204).send()
    },
  )
}

export default fp(assetRoutes, {
  name: 'asset-routes',
  fastify: '4.x',
})
