import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, jobs, assets, tenants, voiceClones } from '@fantom/db'
import type { Job, JobKind, JobStatus } from '@fantom/db'
import { getPublicUrl } from '@fantom/storage'
import { enqueueJob, getQueue } from '@fantom/jobs'
import { requireAuth } from '../plugins/auth.js'
import { logEvent } from '@fantom/observability'

// ── Type guards ───────────────────────────────────────────────────────────────

const JOB_KINDS: readonly JobKind[] = [
  'render_test_video',
  'render_listing_video',
  'render_market_update',
  'render_virtual_tour',
  'render_flip_video',
  'render_youtube_edit',
]

const JOB_STATUSES: readonly JobStatus[] = [
  'pending',
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
]

function isJobKind(v: unknown): v is JobKind {
  return typeof v === 'string' && (JOB_KINDS as readonly string[]).includes(v)
}

function isJobStatus(v: unknown): v is JobStatus {
  return typeof v === 'string' && (JOB_STATUSES as readonly string[]).includes(v)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getTenantSlug(tenantId: string): Promise<string | null> {
  const [row] = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    return tx.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  })
  return row?.slug ?? null
}

async function attachOutputAsset(
  jobRows: Job[],
  tenantId: string,
): Promise<Array<Job & { outputAsset: (typeof assets.$inferSelect & { publicUrl: string }) | null }>> {
  const assetIds = jobRows
    .map((j) => j.outputAssetId)
    .filter((id): id is string => id != null)

  const assetMap = new Map<string, typeof assets.$inferSelect & { publicUrl: string }>()

  if (assetIds.length > 0) {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      return tx.select().from(assets).where(inArray(assets.id, assetIds))
    })
    for (const a of rows) {
      assetMap.set(a.id, { ...a, publicUrl: getPublicUrl(a.r2Key) })
    }
  }

  return jobRows.map((j) => ({
    ...j,
    outputAsset: j.outputAssetId ? (assetMap.get(j.outputAssetId) ?? null) : null,
  }))
}

// ── Routes ────────────────────────────────────────────────────────────────────

const jobRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /jobs ─────────────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      kind: string
      input: { voiceCloneId?: string; text?: string; imageAssetId?: string }
    }
  }>('/jobs', { preHandler: requireAuth }, async (request, reply) => {
    const { kind, input } = request.body ?? {}
    const tenantId = request.tenantId!
    const userId = request.user!.id

    if (!isJobKind(kind)) {
      return reply.code(400).send({ error: 'Invalid job kind' })
    }
    if (kind !== 'render_test_video') {
      return reply.code(400).send({ error: 'Job kind not yet implemented' })
    }

    // Validate render_test_video input
    const { voiceCloneId, text, imageAssetId } = input ?? {}
    if (typeof voiceCloneId !== 'string' || !voiceCloneId) {
      return reply.code(400).send({ error: 'input.voiceCloneId is required' })
    }
    if (typeof text !== 'string' || !text.trim()) {
      return reply.code(400).send({ error: 'input.text is required' })
    }
    if (text.length > 5000) {
      return reply.code(400).send({ error: 'input.text must be under 5000 characters' })
    }
    if (typeof imageAssetId !== 'string' || !imageAssetId) {
      return reply.code(400).send({ error: 'input.imageAssetId is required' })
    }

    // Verify referenced assets belong to this tenant (RLS enforces isolation)
    const voiceCloneExists = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx
        .select({ id: voiceClones.id })
        .from(voiceClones)
        .where(eq(voiceClones.id, voiceCloneId))
        .limit(1)
      return row != null
    })
    if (!voiceCloneExists) return reply.code(404).send({ error: 'Voice clone not found' })

    const imageAssetExists = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.id, imageAssetId), eq(assets.kind, 'image')))
        .limit(1)
      return row != null
    })
    if (!imageAssetExists) return reply.code(404).send({ error: 'Image asset not found' })

    // Insert job
    const job = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx
        .insert(jobs)
        .values({
          tenantId,
          createdByUserId: userId,
          kind,
          status: 'pending',
          input: { voiceCloneId, text: text.trim(), imageAssetId },
        })
        .returning()
      return row
    })

    if (!job) return reply.code(500).send({ error: 'Failed to create job' })

    // Enqueue via BullMQ
    try {
      await enqueueJob({ jobId: job.id, tenantId, kind })
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        await tx.update(jobs).set({ status: 'queued', updatedAt: new Date() }).where(eq(jobs.id, job.id))
      })
      logEvent({
        tenantId,
        kind: 'job.created',
        severity: 'info',
        actorUserId: userId,
        subjectType: 'job',
        subjectId: job.id,
        metadata: { jobKind: kind },
      })
      return reply.code(201).send({ ...job, status: 'queued', outputAsset: null })
    } catch (err) {
      fastify.log.error(err, 'Failed to enqueue job')
      logEvent({
        tenantId,
        kind: 'job.created',
        severity: 'info',
        actorUserId: userId,
        subjectType: 'job',
        subjectId: job.id,
        metadata: { jobKind: kind, queued: false },
      })
      return reply.code(201).send({ ...job, outputAsset: null })
    }
  })

  // GET /jobs ───────────────────────────────────────────────────────────────────
  fastify.get<{
    Querystring: { kind?: string; status?: string; limit?: string; cursor?: string }
  }>('/jobs', { preHandler: requireAuth }, async (request, reply) => {
    const { kind, status, cursor } = request.query
    const limit = Math.min(Number(request.query.limit ?? 20), 100)
    const tenantId = request.tenantId!

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)

      const conditions = [eq(jobs.tenantId, tenantId)]
      if (isJobKind(kind)) conditions.push(eq(jobs.kind, kind))
      if (isJobStatus(status)) conditions.push(eq(jobs.status, status))
      if (typeof cursor === 'string' && cursor) {
        conditions.push(lt(jobs.createdAt, new Date(cursor)))
      }

      return tx
        .select()
        .from(jobs)
        .where(and(...conditions))
        .orderBy(desc(jobs.createdAt))
        .limit(limit + 1)
    })

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const withAssets = await attachOutputAsset(page, tenantId)

    return reply.send({
      jobs: withAssets,
      nextCursor: hasMore ? page[page.length - 1]?.createdAt.toISOString() : undefined,
    })
  })

  // GET /jobs/:id ───────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/jobs/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      const job = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx.select().from(jobs).where(eq(jobs.id, id)).limit(1)
        return row
      })

      if (!job) return reply.code(404).send({ error: 'Job not found' })

      const [withAsset] = await attachOutputAsset([job], tenantId)
      return reply.send(withAsset)
    },
  )

  // POST /jobs/:id/cancel ────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/jobs/:id/cancel',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      const job = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx.select().from(jobs).where(eq(jobs.id, id)).limit(1)
        return row
      })

      if (!job) return reply.code(404).send({ error: 'Job not found' })
      if (job.status !== 'pending' && job.status !== 'queued' && job.status !== 'processing') {
        return reply.code(409).send({ error: 'Only pending, queued, or processing jobs can be cancelled' })
      }

      // Remove from BullMQ queue (best-effort; no-op for processing jobs already running)
      try {
        const bullJob = await getQueue().getJob(id)
        if (bullJob) await bullJob.remove()
      } catch (err) {
        fastify.log.warn(err, `Failed to remove job ${id} from BullMQ queue`)
      }

      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx
          .update(jobs)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(jobs.id, id))
          .returning()
        return row
      })

      logEvent({
        tenantId,
        kind: 'job.cancelled',
        severity: 'info',
        actorUserId: request.user!.id,
        subjectType: 'job',
        subjectId: id,
      })
      return reply.send({ ...updated, outputAsset: null })
    },
  )

  // POST /jobs/:id/retry ────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/jobs/:id/retry',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      const job = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx.select().from(jobs).where(eq(jobs.id, id)).limit(1)
        return row
      })

      if (!job) return reply.code(404).send({ error: 'Job not found' })
      if (job.status !== 'failed') {
        return reply.code(409).send({ error: 'Only failed jobs can be retried' })
      }

      // Reset job state
      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx
          .update(jobs)
          .set({
            status: 'pending',
            retries: 0,
            progress: 0,
            errorMessage: null,
            errorStack: null,
            startedAt: null,
            completedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(jobs.id, id))
          .returning()
        return row
      })

      if (!updated) return reply.code(500).send({ error: 'Failed to reset job' })

      // Re-enqueue
      try {
        await enqueueJob({ jobId: id, tenantId, kind: job.kind })
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
          await tx
            .update(jobs)
            .set({ status: 'queued', updatedAt: new Date() })
            .where(eq(jobs.id, id))
        })
        return reply.send({ ...updated, status: 'queued', outputAsset: null })
      } catch (err) {
        fastify.log.error(err, 'Failed to re-enqueue job')
        return reply.send({ ...updated, outputAsset: null })
      }
    },
  )
  // DELETE /jobs/:id ───────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/jobs/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      const job = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx.select().from(jobs).where(eq(jobs.id, id)).limit(1)
        return row
      })

      if (!job) return reply.code(404).send({ error: 'Job not found' })

      const TERMINAL: readonly JobStatus[] = ['completed', 'failed', 'cancelled']
      if (!TERMINAL.includes(job.status)) {
        return reply.code(400).send({ error: 'Cancel the job first before deleting' })
      }

      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        await tx.delete(jobs).where(eq(jobs.id, id))
      })

      logEvent({
        tenantId,
        kind: 'job.deleted',
        severity: 'info',
        actorUserId: request.user!.id,
        subjectType: 'job',
        subjectId: id,
        metadata: { previousStatus: job.status },
      })
      return reply.code(204).send()
    },
  )

  // POST /jobs/bulk-delete ──────────────────────────────────────────────────────
  fastify.post<{ Body: { status: 'failed' | 'completed' | 'cancelled' | 'all-terminal' } }>(
    '/jobs/bulk-delete',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { status } = request.body ?? {}
      const tenantId = request.tenantId!

      const VALID_FILTERS = ['failed', 'completed', 'cancelled', 'all-terminal'] as const
      if (!(VALID_FILTERS as readonly string[]).includes(status)) {
        return reply
          .code(400)
          .send({ error: 'status must be one of: failed, completed, cancelled, all-terminal' })
      }

      const statusCondition =
        status === 'all-terminal'
          ? or(eq(jobs.status, 'completed'), eq(jobs.status, 'failed'), eq(jobs.status, 'cancelled'))
          : eq(jobs.status, status)

      const deleted = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx
          .delete(jobs)
          .where(and(eq(jobs.tenantId, tenantId), statusCondition))
          .returning({ id: jobs.id })
      })

      return reply.send({ deletedCount: deleted.length })
    },
  )
}

export default fp(jobRoutes, {
  name: 'job-routes',
  fastify: '4.x',
})
