import { eq, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, assets, tenants } from '@fantom/db'
import { generateUploadUrl, getPublicUrl, getObjectMetadata } from '@fantom/storage'
import { requireAuth } from '../plugins/auth.js'
import { logEvent } from '@fantom/observability'
import { VIDEO_UPLOAD_LIMITS } from '@fantom/shared'
import { enqueueVideoPreprocess } from '@fantom/jobs'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getTenantSlug(tenantId: string): Promise<string | null> {
  const [row] = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    return tx.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  })
  return row?.slug ?? null
}

/**
 * Validate video dimensions: shorter side must be >= MIN_DIMENSION.
 * Accepts landscape (1920×1080) and portrait (1080×1920). Rejects 1280×720.
 */
function isResolutionValid(width: number, height: number): boolean {
  return Math.min(width, height) >= VIDEO_UPLOAD_LIMITS.MIN_DIMENSION
}

function validateVideoBody(body: {
  mimeType: unknown
  sizeBytes: unknown
  durationSeconds: unknown
  width: unknown
  height: unknown
}): string | null {
  const { mimeType, sizeBytes, durationSeconds, width, height } = body

  if (typeof mimeType !== 'string' || !(VIDEO_UPLOAD_LIMITS.ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return `mimeType '${mimeType}' is not allowed. Accepted: ${VIDEO_UPLOAD_LIMITS.ALLOWED_MIME_TYPES.join(', ')}`
  }
  if (typeof sizeBytes !== 'number' || sizeBytes <= 0) {
    return 'sizeBytes must be a positive number'
  }
  if (sizeBytes > VIDEO_UPLOAD_LIMITS.MAX_SIZE_BYTES) {
    return `File too large: ${(sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB. Maximum is 20 GB.`
  }
  if (typeof durationSeconds !== 'number' || durationSeconds <= 0) {
    return 'durationSeconds must be a positive number'
  }
  if (durationSeconds > VIDEO_UPLOAD_LIMITS.MAX_DURATION_SECONDS) {
    return `Video too long: ${Math.round(durationSeconds / 60)} min. Maximum is 120 min.`
  }
  if (typeof width !== 'number' || typeof height !== 'number' || width < 1 || height < 1) {
    return 'width and height must be positive integers'
  }
  if (!isResolutionValid(width, height)) {
    return `Resolution too low: ${width}×${height}. Minimum is 1080p (shorter dimension ≥ 1080px).`
  }
  return null
}

// ── Routes ────────────────────────────────────────────────────────────────────

const videoRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /videos/upload-url ────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      filename: string
      mimeType: string
      sizeBytes: number
      durationSeconds: number
      width: number
      height: number
    }
  }>('/videos/upload-url', { preHandler: requireAuth }, async (request, reply) => {
    const { filename, mimeType, sizeBytes, durationSeconds, width, height } = request.body ?? {}

    if (typeof filename !== 'string' || !filename.trim()) {
      return reply.code(400).send({ error: 'filename is required' })
    }

    const validationError = validateVideoBody({ mimeType, sizeBytes, durationSeconds, width, height })
    if (validationError) return reply.code(400).send({ error: validationError })

    const tenantId = request.tenantId!
    const slug = await getTenantSlug(tenantId)
    if (!slug) return reply.code(404).send({ error: 'Tenant not found' })

    // Use 'videos' as the kind prefix → R2 key: ${slug}/videos/${yyyy}/${mm}/${uuid}-${filename}
    const { uploadUrl, key: r2Key, expiresAt } = await generateUploadUrl(
      slug,
      'videos',
      filename.trim(),
      mimeType,
    )

    return reply.send({ uploadUrl, r2Key, expiresAt })
  })

  // POST /videos ────────────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      r2Key: string
      originalFilename: string
      mimeType: string
      sizeBytes: number
      durationSeconds: number
      width: number
      height: number
    }
  }>('/videos', { preHandler: requireAuth }, async (request, reply) => {
    const { r2Key, originalFilename, mimeType, sizeBytes, durationSeconds, width, height } =
      request.body ?? {}

    if (typeof r2Key !== 'string' || !r2Key) {
      return reply.code(400).send({ error: 'r2Key is required' })
    }
    if (typeof originalFilename !== 'string' || !originalFilename.trim()) {
      return reply.code(400).send({ error: 'originalFilename is required' })
    }

    // Re-validate everything server-side (defense in depth)
    const validationError = validateVideoBody({ mimeType, sizeBytes, durationSeconds, width, height })
    if (validationError) return reply.code(400).send({ error: validationError })

    const tenantId = request.tenantId!
    const slug = await getTenantSlug(tenantId)
    if (!slug) return reply.code(404).send({ error: 'Tenant not found' })

    // Cross-tenant key spoofing prevention — key must be under this tenant's video prefix
    if (!r2Key.startsWith(`${slug}/videos/`)) {
      return reply.code(403).send({ error: 'Key does not belong to your tenant video store' })
    }

    // Confirm the file actually landed in R2
    let r2SizeBytes: number
    try {
      const meta = await getObjectMetadata(r2Key)
      r2SizeBytes = meta.sizeBytes
    } catch {
      return reply.code(422).send({ error: 'File not found in storage — upload may have failed' })
    }

    // Re-validate size against what R2 actually received
    if (r2SizeBytes > VIDEO_UPLOAD_LIMITS.MAX_SIZE_BYTES) {
      return reply.code(400).send({ error: 'File exceeds 20 GB limit' })
    }

    const userId = request.user!.id

    const asset = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx
        .insert(assets)
        .values({
          tenantId,
          uploadedByUserId: userId,
          kind: 'video',
          originalFilename: originalFilename.trim(),
          mimeType,
          sizeBytes: r2SizeBytes,
          r2Key,
          width,
          height,
          durationSeconds: String(durationSeconds),
          transcriptionStatus: 'pending',
          tags: [],
          metadata: { source: 'upload' },
        })
        .returning()
      return row
    })

    if (!asset) return reply.code(500).send({ error: 'Failed to create video asset' })

    logEvent({
      tenantId,
      kind: 'asset.uploaded',
      severity: 'info',
      actorUserId: userId,
      subjectType: 'asset',
      subjectId: asset.id,
      metadata: {
        kind: 'video',
        mimeType,
        sizeBytes: r2SizeBytes,
        durationSeconds,
        width,
        height,
      },
    })

    // Best-effort enqueue — never fail the response if Redis is unavailable
    enqueueVideoPreprocess({ assetId: asset.id, tenantId }).catch((err) => {
      fastify.log.warn({ err, assetId: asset.id }, 'Failed to enqueue video_preprocess')
    })

    return reply.code(201).send({
      ...asset,
      publicUrl: getPublicUrl(asset.r2Key),
      thumbnailPublicUrl: null,
      normalizedPublicUrl: null,
    })
  })
  // POST /videos/:id/reprocess ─────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/videos/:id/reprocess',
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
      if (asset.kind !== 'video') return reply.code(400).send({ error: 'Asset is not a video' })

      await enqueueVideoPreprocess({ assetId: id, tenantId })

      return reply.code(202).send({ queued: true })
    },
  )
}

export default fp(videoRoutes, {
  name: 'video-routes',
  fastify: '4.x',
})
