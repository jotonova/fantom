import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, shortsBriefs, shortsRenders, assets, brandKits, voiceClones, musicTracks } from '@fantom/db'
import type { ShortsBrief, ShortsRender } from '@fantom/db'
import { getPublicUrl, deleteObject } from '@fantom/storage'
import { enqueueShortsBriefRender } from '@fantom/jobs'
import {
  validateBriefForReady,
  estimateBriefCost,
  type BriefForValidation,
} from '@fantom/shared'
import { logEvent } from '@fantom/observability'
import { requireAuth } from '../plugins/auth.js'

// ── Validation helpers ────────────────────────────────────────────────────────

const VALID_DURATIONS = new Set([15, 30, 45, 60])
const VALID_PACINGS = new Set(['fast', 'medium', 'slow'])
const VALID_STATUSES = new Set(['draft', 'ready', 'rendering', 'rendered', 'failed'])

// ── Client serialisation ──────────────────────────────────────────────────────
// mainScenes is stored as jsonb — pass the array through as-is (null if unset).

function formatForClient(brief: ShortsBrief) {
  return {
    ...brief,
    mainScenes: Array.isArray(brief.mainScenes) ? brief.mainScenes : null,
  }
}

function toBriefForValidation(brief: ShortsBrief): BriefForValidation {
  return {
    sourceAssetIds: brief.sourceAssetIds,
    voiceCloneId: brief.voiceCloneId,
    brandKitId: brief.brandKitId,
    musicTrackId: brief.musicTrackId,
    opening: brief.opening,
    openingVoiceoverScript: brief.openingVoiceoverScript,
    mainScenes: Array.isArray(brief.mainScenes) ? brief.mainScenes : null,
    closing: brief.closing,
    closingVoiceoverScript: brief.closingVoiceoverScript,
    durationSeconds: brief.durationSeconds,
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

const shortsBriefRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /shorts-briefs ─────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      title?: string
      description?: string
      sourceAssetIds?: string[]
      brandKitId?: string | null
      voiceCloneId?: string | null
      musicTrackId?: string | null
      durationSeconds?: number
      opening?: string | null
      openingVoiceoverScript?: string | null
      closing?: string | null
      closingVoiceoverScript?: string | null
      pacing?: string | null
      mainScenes?: Array<{ id: string; description: string; voiceover_script?: string }> | null
    }
  }>('/shorts-briefs', { preHandler: requireAuth }, async (request, reply) => {
    const body = request.body ?? {}
    const { title, sourceAssetIds, durationSeconds = 30 } = body

    if (typeof title !== 'string' || !title.trim()) {
      return reply.code(400).send({ error: 'title is required' })
    }
    if (!Array.isArray(sourceAssetIds) || sourceAssetIds.length === 0) {
      return reply.code(400).send({ error: 'sourceAssetIds must be a non-empty array' })
    }
    if (!VALID_DURATIONS.has(durationSeconds)) {
      return reply.code(400).send({ error: 'durationSeconds must be 15, 30, 45, or 60' })
    }
    if (body.pacing !== undefined && body.pacing !== null && !VALID_PACINGS.has(body.pacing)) {
      return reply.code(400).send({ error: 'pacing must be fast, medium, or slow' })
    }

    const tenantId = request.tenantId!
    const userId = request.user!.id

    const brief = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx
        .insert(shortsBriefs)
        .values({
          tenantId,
          createdByUserId: userId,
          title: title.trim(),
          description: typeof body.description === 'string' ? body.description : null,
          sourceAssetIds,
          brandKitId: body.brandKitId ?? null,
          voiceCloneId: body.voiceCloneId ?? null,
          musicTrackId: body.musicTrackId ?? null,
          durationSeconds,
          opening: body.opening ?? null,
          openingVoiceoverScript: body.openingVoiceoverScript ?? null,
          closing: body.closing ?? null,
          closingVoiceoverScript: body.closingVoiceoverScript ?? null,
          pacing: (body.pacing as ShortsBrief['pacing']) ?? null,
          mainScenes: Array.isArray(body.mainScenes) ? body.mainScenes : null,
          status: 'draft',
        })
        .returning()
      return row
    })

    if (!brief) return reply.code(500).send({ error: 'Failed to create brief' })
    return reply.code(201).send(formatForClient(brief))
  })

  // GET /shorts-briefs ──────────────────────────────────────────────────────────
  fastify.get<{
    Querystring: { status?: string; limit?: string; cursor?: string }
  }>('/shorts-briefs', { preHandler: requireAuth }, async (request, reply) => {
    const { status, cursor } = request.query
    const limit = Math.min(Number(request.query.limit ?? 20), 100)
    const tenantId = request.tenantId!

    if (status && !VALID_STATUSES.has(status)) {
      return reply.code(400).send({ error: 'Invalid status filter' })
    }

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)

      const conditions = [eq(shortsBriefs.tenantId, tenantId)]
      if (status) conditions.push(eq(shortsBriefs.status, status as ShortsBrief['status']))
      if (cursor) conditions.push(lt(shortsBriefs.createdAt, new Date(cursor)))

      return tx
        .select()
        .from(shortsBriefs)
        .where(and(...conditions))
        .orderBy(desc(shortsBriefs.createdAt))
        .limit(limit + 1)
    })

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const nextCursor =
      hasMore && page.length > 0 ? page[page.length - 1]!.createdAt.toISOString() : undefined

    return reply.send({ shortsBriefs: page.map(formatForClient), nextCursor })
  })

  // GET /shorts-briefs/:id/preview ──────────────────────────────────────────────
  // Must be registered BEFORE /shorts-briefs/:id to avoid route collision.
  fastify.get<{ Params: { id: string } }>(
    '/shorts-briefs/:id/preview',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      // Fetch brief
      const brief = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx.select().from(shortsBriefs).where(eq(shortsBriefs.id, id)).limit(1)
        return row
      })

      if (!brief) return reply.code(404).send({ error: 'Brief not found' })
      const formatted = formatForClient(brief)

      // Fetch source clips (in sourceAssetIds order)
      const clipRows =
        brief.sourceAssetIds.length > 0
          ? await db.transaction(async (tx) => {
              await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
              return tx
                .select({
                  id: assets.id,
                  originalFilename: assets.originalFilename,
                  durationSeconds: assets.durationSeconds,
                  sceneCount: assets.sceneCount,
                  thumbnailR2Key: assets.thumbnailR2Key,
                })
                .from(assets)
                .where(
                  and(
                    eq(assets.tenantId, tenantId),
                    inArray(assets.id, brief.sourceAssetIds),
                  ),
                )
            })
          : []

      // Preserve source_asset_ids order; hydrate thumbnail URL
      const clipMap = new Map(clipRows.map((r) => [r.id, r]))
      const clips = brief.sourceAssetIds
        .map((assetId) => clipMap.get(assetId))
        .filter(Boolean)
        .map((r) => ({
          id: r!.id,
          originalFilename: r!.originalFilename,
          durationSeconds: r!.durationSeconds,
          sceneCount: r!.sceneCount,
          thumbnailPublicUrl: r!.thumbnailR2Key ? getPublicUrl(r!.thumbnailR2Key) : null,
        }))

      // Resolve brand kit name
      let brandKitName: string | null = null
      if (brief.brandKitId) {
        const [kit] = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
          return tx
            .select({ name: brandKits.name })
            .from(brandKits)
            .where(eq(brandKits.id, brief.brandKitId!))
            .limit(1)
        })
        brandKitName = kit?.name ?? null
      }

      // Resolve music track name
      let musicTrackName: string | null = null
      if (brief.musicTrackId) {
        const [track] = await db
          .select({ title: musicTracks.title, isActive: musicTracks.isActive })
          .from(musicTracks)
          .where(eq(musicTracks.id, brief.musicTrackId))
          .limit(1)
        musicTrackName = track?.title ?? null
      }

      // Resolve voice clone name (voiceCloneId stores the ElevenLabs providerVoiceId)
      let voiceCloneName: string | null = null
      if (brief.voiceCloneId) {
        const [clone] = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
          return tx
            .select({ name: voiceClones.name })
            .from(voiceClones)
            .where(
              and(
                eq(voiceClones.tenantId, tenantId),
                eq(voiceClones.providerVoiceId, brief.voiceCloneId!),
              ),
            )
            .limit(1)
        })
        voiceCloneName = clone?.name ?? brief.voiceCloneId
      }

      // Compute estimates and run validation
      const briefForValidation = toBriefForValidation(brief)
      const estimates = estimateBriefCost(briefForValidation, clips.length)
      const validation = validateBriefForReady(briefForValidation, clips)

      return reply.send({
        brief: formatted,
        clips,
        brandKitName,
        voiceCloneName,
        musicTrackName,
        estimates,
        validation,
      })
    },
  )

  // POST /shorts-briefs/:id/render ──────────────────────────────────────────────
  // Enqueues a render job for a 'ready' brief. Returns 201 with the render row.
  // Must be registered BEFORE /shorts-briefs/:id to avoid route collision.
  fastify.post<{ Params: { id: string } }>(
    '/shorts-briefs/:id/render',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      // Fetch brief
      const brief = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx.select().from(shortsBriefs).where(eq(shortsBriefs.id, id)).limit(1)
        return row
      })

      if (!brief) return reply.code(404).send({ error: 'Brief not found' })
      if (brief.status !== 'ready') {
        return reply.code(409).send({
          error: `Brief must be in 'ready' status to generate (current: ${brief.status})`,
        })
      }

      // Check for an already-active render (queued or running)
      const activeRender = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx
          .select()
          .from(shortsRenders)
          .where(
            and(
              eq(shortsRenders.briefId, id),
              eq(shortsRenders.tenantId, tenantId),
            ),
          )
          .orderBy(desc(shortsRenders.createdAt))
          .limit(1)
        return row
      })

      if (activeRender && (activeRender.status === 'queued' || activeRender.status === 'running')) {
        return reply.code(409).send({
          error: `A render is already ${activeRender.status} for this brief`,
          renderId: activeRender.id,
        })
      }

      // Create render row
      const render = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx
          .insert(shortsRenders)
          .values({
            tenantId,
            briefId: id,
            status: 'queued',
          })
          .returning()
        return row
      })

      if (!render) return reply.code(500).send({ error: 'Failed to create render job' })

      // Enqueue BullMQ job
      const bullJobId = await enqueueShortsBriefRender({
        renderId: render.id,
        briefId: id,
        tenantId,
      })

      // Persist BullMQ job ID back to the render row
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        await tx
          .update(shortsRenders)
          .set({ bullmqJobId: bullJobId, updatedAt: new Date() })
          .where(eq(shortsRenders.id, render.id))
      })

      logEvent({
        tenantId,
        kind: 'shorts.render.queued',
        severity: 'info',
        subjectType: 'shorts_render',
        subjectId: render.id,
        metadata: { briefId: id, bullmqJobId: bullJobId },
      })

      return reply.code(201).send({ ...render, bullmqJobId: bullJobId })
    },
  )

  // GET /shorts-briefs/:id/render ───────────────────────────────────────────────
  // Returns the latest render for this brief, with output URL if completed.
  // Must be registered BEFORE /shorts-briefs/:id to avoid route collision.
  fastify.get<{ Params: { id: string } }>(
    '/shorts-briefs/:id/render',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      // Verify brief exists
      const brief = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx
          .select({ id: shortsBriefs.id })
          .from(shortsBriefs)
          .where(eq(shortsBriefs.id, id))
          .limit(1)
        return row
      })

      if (!brief) return reply.code(404).send({ error: 'Brief not found' })

      // Fetch latest render
      const render = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx
          .select()
          .from(shortsRenders)
          .where(
            and(
              eq(shortsRenders.briefId, id),
              eq(shortsRenders.tenantId, tenantId),
            ),
          )
          .orderBy(desc(shortsRenders.createdAt))
          .limit(1)
        return row
      })

      if (!render) return reply.code(404).send({ error: 'No render found for this brief' })

      // Hydrate output URL if completed
      let outputUrl: string | null = null
      if (render.outputAssetId) {
        const asset = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
          const [row] = await tx
            .select({ r2Key: assets.r2Key })
            .from(assets)
            .where(eq(assets.id, render.outputAssetId!))
            .limit(1)
          return row
        })
        if (asset) outputUrl = getPublicUrl(asset.r2Key)
      }

      return reply.send({ ...render, outputUrl })
    },
  )

  // GET /shorts-briefs/:id ──────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/shorts-briefs/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      const brief = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx
          .select()
          .from(shortsBriefs)
          .where(eq(shortsBriefs.id, id))
          .limit(1)
        return row
      })

      if (!brief) return reply.code(404).send({ error: 'Brief not found' })
      return reply.send(formatForClient(brief))
    },
  )

  // PATCH /shorts-briefs/:id ────────────────────────────────────────────────────
  // Handles two distinct operations:
  //   1. Status transitions: { status: 'ready' } or { status: 'draft' }
  //   2. Field edits: any field except status (requires current status='draft')
  // These are intentionally separate PATCH calls from the UI.
  fastify.patch<{
    Params: { id: string }
    Body: {
      title?: string
      description?: string | null
      sourceAssetIds?: string[]
      brandKitId?: string | null
      voiceCloneId?: string | null
      musicTrackId?: string | null
      durationSeconds?: number
      opening?: string | null
      openingVoiceoverScript?: string | null
      closing?: string | null
      closingVoiceoverScript?: string | null
      pacing?: string | null
      mainScenes?: Array<{ id: string; description: string; voiceover_script?: string }> | null
      status?: string
    }
  }>('/shorts-briefs/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params
    const tenantId = request.tenantId!
    const body = request.body ?? {}

    // Fetch existing brief
    const existing = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx.select().from(shortsBriefs).where(eq(shortsBriefs.id, id)).limit(1)
      return row
    })

    if (!existing) return reply.code(404).send({ error: 'Brief not found' })

    const patch: Partial<typeof shortsBriefs.$inferInsert> = {}

    // ── Status transition ──────────────────────────────────────────────────────
    const hasStatusChange = 'status' in body
    let effectiveStatus = existing.status // status after any transition

    if (hasStatusChange) {
      const newStatus = body.status

      if (newStatus === 'ready') {
        // Only draft → ready is allowed here
        if (existing.status !== 'draft') {
          return reply.code(409).send({
            error: `Can only mark ready from draft (current status: ${existing.status})`,
          })
        }

        // Fetch clips for validation
        const clipRows =
          existing.sourceAssetIds.length > 0
            ? await db.transaction(async (tx) => {
                await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
                return tx
                  .select({ id: assets.id, durationSeconds: assets.durationSeconds, sceneCount: assets.sceneCount })
                  .from(assets)
                  .where(inArray(assets.id, existing.sourceAssetIds))
              })
            : []

        const { blockers } = validateBriefForReady(toBriefForValidation(existing), clipRows)
        if (blockers.length > 0) {
          return reply.code(409).send({ error: 'Brief has blocking validation errors', blockers })
        }

        patch.status = 'ready'
        effectiveStatus = 'ready'
      } else if (newStatus === 'draft') {
        // Allowed: ready → draft (edit unlock), cancelled → draft, failed → draft (retry)
        const allowedFromStatuses = ['ready', 'cancelled', 'failed']
        if (!allowedFromStatuses.includes(existing.status)) {
          return reply.code(409).send({
            error: `Can only revert to draft from ready, cancelled, or failed (current status: ${existing.status})`,
          })
        }
        patch.status = 'draft'
        patch.errorMessage = null
        effectiveStatus = 'draft'
      } else {
        // rendering/rendered/failed transitions are managed by the render pipeline
        return reply.code(409).send({
          error: `Status '${newStatus}' cannot be set via this endpoint. Only 'ready' and 'draft' transitions are allowed here.`,
        })
      }
    }

    // ── Field edits ────────────────────────────────────────────────────────────
    const fieldKeys = Object.keys(body).filter((k) => k !== 'status')

    if (fieldKeys.length > 0) {
      // Field edits require draft state (current or effective after transition)
      if (effectiveStatus !== 'draft') {
        return reply.code(409).send({
          error: `Field edits require draft status (current: ${existing.status})`,
        })
      }

      if (typeof body.title === 'string') {
        if (!body.title.trim()) return reply.code(400).send({ error: 'title cannot be empty' })
        patch.title = body.title.trim()
      }
      if ('description' in body) patch.description = body.description ?? null
      if (Array.isArray(body.sourceAssetIds)) {
        if (body.sourceAssetIds.length === 0) {
          return reply.code(400).send({ error: 'sourceAssetIds cannot be empty' })
        }
        patch.sourceAssetIds = body.sourceAssetIds
      }
      if ('brandKitId' in body) patch.brandKitId = body.brandKitId ?? null
      if ('voiceCloneId' in body) patch.voiceCloneId = body.voiceCloneId ?? null
      if ('musicTrackId' in body) patch.musicTrackId = body.musicTrackId ?? null
      if (typeof body.durationSeconds === 'number') {
        if (!VALID_DURATIONS.has(body.durationSeconds)) {
          return reply.code(400).send({ error: 'durationSeconds must be 15, 30, 45, or 60' })
        }
        patch.durationSeconds = body.durationSeconds
      }
      if ('opening' in body) patch.opening = body.opening ?? null
      if ('openingVoiceoverScript' in body) patch.openingVoiceoverScript = body.openingVoiceoverScript ?? null
      if ('closing' in body) patch.closing = body.closing ?? null
      if ('closingVoiceoverScript' in body) patch.closingVoiceoverScript = body.closingVoiceoverScript ?? null
      if ('pacing' in body) {
        if (body.pacing !== null && body.pacing !== undefined && !VALID_PACINGS.has(body.pacing)) {
          return reply.code(400).send({ error: 'pacing must be fast, medium, or slow' })
        }
        patch.pacing = (body.pacing as ShortsBrief['pacing']) ?? null
      }
      if ('mainScenes' in body) patch.mainScenes = Array.isArray(body.mainScenes) ? body.mainScenes : null
    }

    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'No valid fields to update' })
    }

    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx
        .update(shortsBriefs)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(shortsBriefs.id, id))
        .returning()
      return row
    })

    if (!updated) return reply.code(500).send({ error: 'Update failed' })
    return reply.send(formatForClient(updated))
  })

  // DELETE /shorts-briefs/:id ───────────────────────────────────────────────────
  // Allowed from any status except 'rendering' (would orphan an in-flight job).
  // Also cleans up rendered output assets from R2 on delete.
  fastify.delete<{ Params: { id: string } }>(
    '/shorts-briefs/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      const existing = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx
          .select({ id: shortsBriefs.id, status: shortsBriefs.status })
          .from(shortsBriefs)
          .where(eq(shortsBriefs.id, id))
          .limit(1)
        return row
      })

      if (!existing) return reply.code(404).send({ error: 'Brief not found' })
      if (existing.status === 'rendering') {
        return reply.code(409).send({
          error: 'Cannot delete brief while rendering — cancel the render first',
        })
      }

      // Collect output asset IDs from all renders before deletion
      const renderRows = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx
          .select({ outputAssetId: shortsRenders.outputAssetId })
          .from(shortsRenders)
          .where(eq(shortsRenders.briefId, id))
      })

      const outputAssetIds = renderRows
        .map((r) => r.outputAssetId)
        .filter((assetId): assetId is string => assetId != null)

      // Fetch r2Keys for output assets so we can clean up R2 after DB delete
      let outputAssets: Array<{ id: string; r2Key: string }> = []
      if (outputAssetIds.length > 0) {
        outputAssets = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
          return tx
            .select({ id: assets.id, r2Key: assets.r2Key })
            .from(assets)
            .where(inArray(assets.id, outputAssetIds))
        })
      }

      // Delete brief — cascades to shorts_renders (FK ON DELETE CASCADE)
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        await tx.delete(shortsBriefs).where(eq(shortsBriefs.id, id))
      })

      // Delete output asset records (shorts_renders.output_asset_id is SET NULL, not CASCADE)
      if (outputAssets.length > 0) {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
          await tx
            .delete(assets)
            .where(inArray(assets.id, outputAssets.map((a) => a.id)))
        })

        // Delete R2 objects — fail-soft: orphaned objects are recoverable
        for (const asset of outputAssets) {
          deleteObject(asset.r2Key).catch((err) => {
            fastify.log.error(
              { err, r2Key: asset.r2Key, briefId: id },
              '[brief-delete] R2 cleanup failed — object orphaned',
            )
          })
        }
      }

      return reply.code(204).send()
    },
  )
}

export default fp(shortsBriefRoutes, {
  name: 'shorts-brief-routes',
  fastify: '4.x',
})
