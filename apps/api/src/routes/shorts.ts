import { and, desc, eq, lt, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, shortsJobs, jobs, assets } from '@fantom/db'
import type { ShortsJob } from '@fantom/db'
import { getPublicUrl } from '@fantom/storage'
import { requireAuth } from '../plugins/auth.js'
import { enqueueShortRender, enqueueScheduledShortPost } from '@fantom/jobs'
import { generateShortScript } from '@fantom/ai-scripts'
import { logEvent } from '@fantom/observability'

// ── Scheduling helpers ────────────────────────────────────────────────────────

// America/Phoenix is UTC-7 all year (no DST).
// 3pm AZ = 22:00 UTC, 5pm AZ = 00:00 UTC (next day).
const WINDOW_START_UTC_HOUR = 22
const WINDOW_DURATION_MS = 2 * 60 * 60 * 1000 // 2 hours

function getNextPostingWindow(): Date {
  const now = new Date()
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), WINDOW_START_UTC_HOUR, 0, 0, 0))

  // Has today's window already opened?
  if (now >= today) {
    // If we're still in the window (before +2h), jitter within remaining time
    const windowEnd = new Date(today.getTime() + WINDOW_DURATION_MS)
    if (now < windowEnd) {
      const remainingMs = windowEnd.getTime() - now.getTime()
      return new Date(now.getTime() + Math.random() * remainingMs)
    }
    // Window has passed — schedule tomorrow
    today.setUTCDate(today.getUTCDate() + 1)
  }

  // Pick random time within the 2-hour window
  return new Date(today.getTime() + Math.random() * WINDOW_DURATION_MS)
}

// ── URL hydration ─────────────────────────────────────────────────────────────

interface ShortsJobWithUrls extends ShortsJob {
  outputVideoUrl: string | null
}

async function withOutputUrl(row: ShortsJob, tenantId: string): Promise<ShortsJobWithUrls> {
  if (!row.outputAssetId) return { ...row, outputVideoUrl: null }

  const asset = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [r] = await tx
      .select({ r2Key: assets.r2Key })
      .from(assets)
      .where(eq(assets.id, row.outputAssetId!))
      .limit(1)
    return r
  })

  return {
    ...row,
    outputVideoUrl: asset ? getPublicUrl(asset.r2Key) : null,
  }
}

// ── Validation helpers ────────────────────────────────────────────────────────

const VALID_VIBES = new Set(['excited_reveal', 'calm_walkthrough', 'educational_breakdown'])
const VALID_MUSIC_VIBES = new Set(['upbeat', 'calm', 'dramatic', 'inspirational', 'none'])

// ── Routes ────────────────────────────────────────────────────────────────────

const shortsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /shorts/generate-script ────────────────────────────────────────────────
  fastify.post<{
    Body: {
      vibe: string
      brandKitName: string
      photoCount: number
      targetDurationSeconds: number
      hint?: string
    }
  }>('/shorts/generate-script', { preHandler: requireAuth }, async (request, reply) => {
    const { vibe, brandKitName, photoCount, targetDurationSeconds, hint } = request.body ?? {}

    if (!VALID_VIBES.has(vibe)) {
      return reply.code(400).send({ error: 'vibe must be excited_reveal, calm_walkthrough, or educational_breakdown' })
    }
    if (typeof brandKitName !== 'string' || !brandKitName.trim()) {
      return reply.code(400).send({ error: 'brandKitName is required' })
    }
    if (typeof photoCount !== 'number' || photoCount < 1 || photoCount > 30) {
      return reply.code(400).send({ error: 'photoCount must be 1–30' })
    }
    if (typeof targetDurationSeconds !== 'number' || targetDurationSeconds < 15 || targetDurationSeconds > 120) {
      return reply.code(400).send({ error: 'targetDurationSeconds must be 15–120' })
    }

    try {
      const scriptInput = {
        vibe: vibe as 'excited_reveal' | 'calm_walkthrough' | 'educational_breakdown',
        brandKitName: brandKitName.trim(),
        photoCount,
        targetDurationSeconds,
        ...(typeof hint === 'string' && hint.trim() ? { hint: hint.trim() } : {}),
      }
      const result = await generateShortScript(scriptInput)
      return reply.send(result)
    } catch (err) {
      fastify.log.error(err, 'generateShortScript failed')
      return reply.code(502).send({ error: 'Script generation failed — try again' })
    }
  })

  // POST /shorts ────────────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      photoAssetIds: string[]
      vibe?: string
      script?: string
      scriptSource?: string
      captionText?: string
      captionSource?: string
      brandKitId?: string
      voiceCloneId?: string
      musicVibe?: string
      targetDurationSeconds?: number
      /** Per-asset motion hints: { [assetId]: "zoom in slowly" } */
      motionHints?: Record<string, string>
    }
  }>('/shorts', { preHandler: requireAuth }, async (request, reply) => {
    const {
      photoAssetIds,
      vibe = 'calm_walkthrough',
      script,
      scriptSource = 'ai_generated',
      captionText,
      captionSource = 'ai_generated',
      brandKitId,
      voiceCloneId,
      musicVibe,
      targetDurationSeconds = 60,
      motionHints,
    } = request.body ?? {}

    if (!Array.isArray(photoAssetIds) || photoAssetIds.length === 0) {
      return reply.code(400).send({ error: 'photoAssetIds must be a non-empty array' })
    }
    if (photoAssetIds.length > 30) {
      return reply.code(400).send({ error: 'Maximum 30 photos per short' })
    }
    if (!VALID_VIBES.has(vibe)) {
      return reply.code(400).send({ error: 'Invalid vibe' })
    }
    if (musicVibe && !VALID_MUSIC_VIBES.has(musicVibe)) {
      return reply.code(400).send({ error: 'Invalid musicVibe' })
    }
    if (typeof voiceCloneId !== 'string' || !voiceCloneId.trim()) {
      return reply.code(400).send({ error: 'voiceCloneId is required' })
    }

    const tenantId = request.tenantId!
    const userId = request.user!.id

    const shortsJob = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx
        .insert(shortsJobs)
        .values({
          tenantId,
          createdByUserId: userId,
          inputAssetIds: photoAssetIds,
          vibe: vibe as ShortsJob['vibe'],
          script: typeof script === 'string' ? script : null,
          scriptSource: (scriptSource as ShortsJob['scriptSource']) ?? 'ai_generated',
          captionText: typeof captionText === 'string' ? captionText : null,
          captionSource: (captionSource as ShortsJob['captionSource']) ?? 'ai_generated',
          brandKitId: typeof brandKitId === 'string' ? brandKitId : null,
          voiceCloneId: typeof voiceCloneId === 'string' ? voiceCloneId : null,
          musicVibe: typeof musicVibe === 'string' ? musicVibe : null,
          targetDurationSeconds: typeof targetDurationSeconds === 'number' ? targetDurationSeconds : 60,
          motionHints: motionHints ?? null,
          status: 'draft',
        })
        .returning()
      return row
    })

    if (!shortsJob) return reply.code(500).send({ error: 'Failed to create shorts job' })

    logEvent({
      tenantId,
      kind: 'short.created',
      severity: 'info',
      actorUserId: userId,
      subjectType: 'shorts_job',
      subjectId: shortsJob.id,
      metadata: { vibe, photoCount: photoAssetIds.length },
    })

    return reply.code(201).send(await withOutputUrl(shortsJob, tenantId))
  })

  // GET /shorts ─────────────────────────────────────────────────────────────────
  fastify.get<{
    Querystring: { status?: string; limit?: string; cursor?: string }
  }>('/shorts', { preHandler: requireAuth }, async (request, reply) => {
    const { status, cursor } = request.query
    const limit = Math.min(Number(request.query.limit ?? 20), 100)
    const tenantId = request.tenantId!

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)

      const conditions = [eq(shortsJobs.tenantId, tenantId)]

      if (typeof status === 'string' && status) {
        conditions.push(eq(shortsJobs.status, status as ShortsJob['status']))
      }
      if (typeof cursor === 'string' && cursor) {
        conditions.push(lt(shortsJobs.createdAt, new Date(cursor)))
      }

      return tx
        .select()
        .from(shortsJobs)
        .where(and(...conditions))
        .orderBy(desc(shortsJobs.createdAt))
        .limit(limit + 1)
    })

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const nextCursor =
      hasMore && page.length > 0 ? page[page.length - 1]!.createdAt.toISOString() : undefined

    const hydrated = await Promise.all(page.map((r) => withOutputUrl(r, tenantId)))

    return reply.send({ shortsJobs: hydrated, nextCursor })
  })

  // GET /shorts/:id ─────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/shorts/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [r] = await tx
          .select()
          .from(shortsJobs)
          .where(eq(shortsJobs.id, id))
          .limit(1)
        return r
      })

      if (!row) return reply.code(404).send({ error: 'Shorts job not found' })

      return reply.send(await withOutputUrl(row, tenantId))
    },
  )

  // PATCH /shorts/:id ───────────────────────────────────────────────────────────
  fastify.patch<{
    Params: { id: string }
    Body: {
      script?: string
      scriptSource?: string
      captionText?: string
      captionSource?: string
      voiceCloneId?: string | null
      brandKitId?: string | null
      musicVibe?: string | null
      targetDurationSeconds?: number
      vibe?: string
      photoAssetIds?: string[]
      /** Per-asset motion hints: { [assetId]: "zoom in slowly" } */
      motionHints?: Record<string, string> | null
    }
  }>('/shorts/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params
    const tenantId = request.tenantId!

    // Fetch existing
    const existing = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [r] = await tx.select().from(shortsJobs).where(eq(shortsJobs.id, id)).limit(1)
      return r
    })

    if (!existing) return reply.code(404).send({ error: 'Shorts job not found' })

    // Only draft/rendered jobs can be edited
    if (!['draft', 'rendered', 'failed'].includes(existing.status)) {
      return reply.code(409).send({ error: `Cannot edit a job with status '${existing.status}'` })
    }

    const body = request.body ?? {}
    const patch: Partial<typeof shortsJobs.$inferInsert> = {}

    if (typeof body.script === 'string') patch.script = body.script
    if (typeof body.scriptSource === 'string') patch.scriptSource = body.scriptSource as ShortsJob['scriptSource']
    if (typeof body.captionText === 'string') patch.captionText = body.captionText
    if ('captionText' in body && body.captionText === null) patch.captionText = null
    if (typeof body.captionSource === 'string') patch.captionSource = body.captionSource as ShortsJob['captionSource']
    if ('voiceCloneId' in body) patch.voiceCloneId = body.voiceCloneId ?? null
    if ('brandKitId' in body) patch.brandKitId = body.brandKitId ?? null
    if ('musicVibe' in body) patch.musicVibe = body.musicVibe ?? null
    if (typeof body.targetDurationSeconds === 'number') patch.targetDurationSeconds = body.targetDurationSeconds
    if (typeof body.vibe === 'string' && VALID_VIBES.has(body.vibe)) {
      patch.vibe = body.vibe as ShortsJob['vibe']
    }
    if (Array.isArray(body.photoAssetIds) && body.photoAssetIds.length > 0) {
      patch.inputAssetIds = body.photoAssetIds
    }
    if ('motionHints' in body) patch.motionHints = body.motionHints ?? null

    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'No valid fields to update' })
    }

    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [r] = await tx
        .update(shortsJobs)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(shortsJobs.id, id))
        .returning()
      return r
    })

    if (!updated) return reply.code(500).send({ error: 'Update failed' })

    return reply.send(await withOutputUrl(updated, tenantId))
  })

  // POST /shorts/:id/render ─────────────────────────────────────────────────────
  // Enqueues the render job (transitions draft → rendering).
  fastify.post<{ Params: { id: string } }>(
    '/shorts/:id/render',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!
      const userId = request.user!.id

      const existing = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [r] = await tx.select().from(shortsJobs).where(eq(shortsJobs.id, id)).limit(1)
        return r
      })

      if (!existing) return reply.code(404).send({ error: 'Shorts job not found' })
      if (!existing.script) return reply.code(422).send({ error: 'Script is required before rendering' })
      if (!existing.inputAssetIds || existing.inputAssetIds.length === 0) {
        return reply.code(422).send({ error: 'At least one photo is required before rendering' })
      }
      if (['rendering', 'approved', 'scheduled', 'posted'].includes(existing.status)) {
        return reply.code(409).send({ error: `Cannot re-render a job with status '${existing.status}'` })
      }

      // Create a jobs record for the render
      const renderJob = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [r] = await tx
          .insert(jobs)
          .values({
            tenantId,
            createdByUserId: userId,
            kind: 'render_short_video',
            status: 'queued',
            input: { shortsJobId: id },
          })
          .returning()
        return r
      })

      if (!renderJob) return reply.code(500).send({ error: 'Failed to create render job' })

      // Link the render job and transition to rendering
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        await tx
          .update(shortsJobs)
          .set({ status: 'rendering', renderJobId: renderJob.id, updatedAt: new Date() })
          .where(eq(shortsJobs.id, id))
      })

      // Enqueue in BullMQ
      await enqueueShortRender({ jobId: renderJob.id, tenantId })

      logEvent({
        tenantId,
        kind: 'short.render_queued',
        severity: 'info',
        actorUserId: userId,
        subjectType: 'shorts_job',
        subjectId: id,
        metadata: { renderJobId: renderJob.id },
      })

      return reply.code(202).send({ shortsJobId: id, renderJobId: renderJob.id, status: 'rendering' })
    },
  )

  // POST /shorts/:id/approve ────────────────────────────────────────────────────
  // Approves and schedules the short for posting in the 3–5pm AZ window.
  fastify.post<{ Params: { id: string } }>(
    '/shorts/:id/approve',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!
      const userId = request.user!.id

      const existing = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [r] = await tx.select().from(shortsJobs).where(eq(shortsJobs.id, id)).limit(1)
        return r
      })

      if (!existing) return reply.code(404).send({ error: 'Shorts job not found' })
      if (existing.status !== 'rendered') {
        return reply.code(409).send({ error: `Cannot approve a job with status '${existing.status}' — must be 'rendered'` })
      }

      const scheduledFor = getNextPostingWindow()
      const delayMs = scheduledFor.getTime() - Date.now()

      // Transition to scheduled
      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [r] = await tx
          .update(shortsJobs)
          .set({ status: 'scheduled', scheduledFor, updatedAt: new Date() })
          .where(eq(shortsJobs.id, id))
          .returning()
        return r
      })

      if (!updated) return reply.code(500).send({ error: 'Approve failed' })

      // Enqueue delayed BullMQ job
      await enqueueScheduledShortPost({ shortsJobId: id, tenantId, delayMs })

      logEvent({
        tenantId,
        kind: 'short.approved',
        severity: 'info',
        actorUserId: userId,
        subjectType: 'shorts_job',
        subjectId: id,
        metadata: { scheduledFor: scheduledFor.toISOString(), delayMs },
      })

      return reply.send(await withOutputUrl(updated, tenantId))
    },
  )

  // POST /shorts/:id/post-now ───────────────────────────────────────────────────
  // Posts the short immediately (skips the scheduling window).
  fastify.post<{ Params: { id: string } }>(
    '/shorts/:id/post-now',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!
      const userId = request.user!.id

      const existing = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [r] = await tx.select().from(shortsJobs).where(eq(shortsJobs.id, id)).limit(1)
        return r
      })

      if (!existing) return reply.code(404).send({ error: 'Shorts job not found' })
      if (!['rendered', 'approved', 'scheduled'].includes(existing.status)) {
        return reply.code(409).send({
          error: `Cannot post a job with status '${existing.status}' — must be rendered, approved, or scheduled`,
        })
      }

      const now = new Date()
      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [r] = await tx
          .update(shortsJobs)
          .set({ status: 'posted', postedAt: now, updatedAt: now })
          .where(eq(shortsJobs.id, id))
          .returning()
        return r
      })

      if (!updated) return reply.code(500).send({ error: 'Post failed' })

      logEvent({
        tenantId,
        kind: 'short.posted',
        severity: 'info',
        actorUserId: userId,
        subjectType: 'shorts_job',
        subjectId: id,
        metadata: { trigger: 'post_now' },
      })

      return reply.send(await withOutputUrl(updated, tenantId))
    },
  )
}

export default fp(shortsRoutes, {
  name: 'shorts-routes',
  fastify: '4.x',
})
