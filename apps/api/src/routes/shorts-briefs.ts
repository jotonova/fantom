import { and, desc, eq, lt, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, shortsBriefs } from '@fantom/db'
import type { ShortsBrief } from '@fantom/db'
import { requireAuth } from '../plugins/auth.js'

// ── Validation helpers ────────────────────────────────────────────────────────

const VALID_DURATIONS = new Set([15, 30, 45, 60])
const VALID_PACINGS = new Set(['fast', 'medium', 'slow'])
const VALID_STATUSES = new Set(['draft', 'ready', 'rendering', 'rendered', 'failed'])

// ── Client serialisation ──────────────────────────────────────────────────────
// mainScenes / voiceoverScripts are stored as jsonb but the UI treats them as
// plain strings (a JSON string scalar is valid jsonb). Cast here so the client
// always sees string | null — never a raw jsonb blob shape.

function formatForClient(brief: ShortsBrief) {
  return {
    ...brief,
    mainScenes: typeof brief.mainScenes === 'string' ? brief.mainScenes : null,
    voiceoverScripts: typeof brief.voiceoverScripts === 'string' ? brief.voiceoverScripts : null,
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
      durationSeconds?: number
      opening?: string | null
      closing?: string | null
      pacing?: string | null
      mainScenes?: string | null
      voiceoverScripts?: string | null
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
          durationSeconds,
          opening: body.opening ?? null,
          closing: body.closing ?? null,
          pacing: (body.pacing as ShortsBrief['pacing']) ?? null,
          mainScenes: body.mainScenes ?? null,
          voiceoverScripts: body.voiceoverScripts ?? null,
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
  fastify.patch<{
    Params: { id: string }
    Body: {
      title?: string
      description?: string | null
      sourceAssetIds?: string[]
      brandKitId?: string | null
      voiceCloneId?: string | null
      durationSeconds?: number
      opening?: string | null
      closing?: string | null
      pacing?: string | null
      mainScenes?: string | null
      voiceoverScripts?: string | null
    }
  }>('/shorts-briefs/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params
    const tenantId = request.tenantId!
    const body = request.body ?? {}

    // Fetch and status-gate
    const existing = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx.select().from(shortsBriefs).where(eq(shortsBriefs.id, id)).limit(1)
      return row
    })

    if (!existing) return reply.code(404).send({ error: 'Brief not found' })
    if (existing.status !== 'draft') {
      return reply.code(409).send({
        error: `Brief is locked — only draft briefs can be edited (current status: ${existing.status})`,
      })
    }

    // Build patch
    const patch: Partial<typeof shortsBriefs.$inferInsert> = {}

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
    if (typeof body.durationSeconds === 'number') {
      if (!VALID_DURATIONS.has(body.durationSeconds)) {
        return reply.code(400).send({ error: 'durationSeconds must be 15, 30, 45, or 60' })
      }
      patch.durationSeconds = body.durationSeconds
    }
    if ('opening' in body) patch.opening = body.opening ?? null
    if ('closing' in body) patch.closing = body.closing ?? null
    if ('pacing' in body) {
      if (body.pacing !== null && body.pacing !== undefined && !VALID_PACINGS.has(body.pacing)) {
        return reply.code(400).send({ error: 'pacing must be fast, medium, or slow' })
      }
      patch.pacing = (body.pacing as ShortsBrief['pacing']) ?? null
    }
    if ('mainScenes' in body) patch.mainScenes = body.mainScenes ?? null
    if ('voiceoverScripts' in body) patch.voiceoverScripts = body.voiceoverScripts ?? null

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
      if (existing.status !== 'draft') {
        return reply.code(409).send({
          error: `Only draft briefs can be deleted (current status: ${existing.status})`,
        })
      }

      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        await tx.delete(shortsBriefs).where(eq(shortsBriefs.id, id))
      })

      return reply.code(204).send()
    },
  )
}

export default fp(shortsBriefRoutes, {
  name: 'shorts-brief-routes',
  fastify: '4.x',
})
