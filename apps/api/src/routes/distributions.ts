import { and, desc, eq, lt, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, jobs, assets, distributions, tenantSettings } from '@fantom/db'
import type { Distribution, DistributionStatus } from '@fantom/db'
import type { DestinationKind } from '@fantom/distribution-bus'
import { getPublicUrl } from '@fantom/storage'
import { enqueueDistribution, getDistributeQueue } from '@fantom/jobs'
import { requireAuth } from '../plugins/auth.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const DESTINATION_KINDS: readonly DestinationKind[] = [
  'webhook',
  'youtube',
  'facebook',
  'instagram',
  'mls',
]

const DISTRIBUTION_STATUSES: readonly DistributionStatus[] = [
  'pending',
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
]

function isDestinationKind(v: unknown): v is DestinationKind {
  return typeof v === 'string' && (DESTINATION_KINDS as readonly string[]).includes(v)
}

function isDistributionStatus(v: unknown): v is DistributionStatus {
  return typeof v === 'string' && (DISTRIBUTION_STATUSES as readonly string[]).includes(v)
}

// ── Webhook config validator ──────────────────────────────────────────────────

function validateWebhookConfig(config: Record<string, unknown>): string | null {
  if (!config['url'] || typeof config['url'] !== 'string') {
    return 'config.url is required for webhook destination'
  }
  if (!config['url'].startsWith('https://')) {
    return 'config.url must use HTTPS'
  }
  return null
}

function validateConfig(kind: DestinationKind, config: Record<string, unknown>): string | null {
  if (kind === 'webhook') return validateWebhookConfig(config)
  return null // Other kinds: accept any config (stubs)
}

// ── Attach publicUrl to distribution asset ────────────────────────────────────

async function attachDistributionAsset(
  rows: Distribution[],
  tenantId: string,
): Promise<Array<Distribution & { outputAsset: { publicUrl: string; originalFilename: string } | null }>> {
  const assetIds = [...new Set(rows.map((r) => r.assetId))]
  const assetMap = new Map<string, string>()
  const filenameMap = new Map<string, string>()

  if (assetIds.length > 0) {
    const assetRows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      return tx
        .select({ id: assets.id, r2Key: assets.r2Key, originalFilename: assets.originalFilename })
        .from(assets)
        .where(
          assetIds.length === 1
            ? eq(assets.id, assetIds[0]!)
            : sql`${assets.id} = ANY(ARRAY[${sql.join(assetIds.map((id) => sql`${id}::uuid`), sql`, `)}])`
        )
    })
    for (const a of assetRows) {
      assetMap.set(a.id, getPublicUrl(a.r2Key))
      filenameMap.set(a.id, a.originalFilename)
    }
  }

  return rows.map((r) => ({
    ...r,
    outputAsset: assetMap.has(r.assetId)
      ? { publicUrl: assetMap.get(r.assetId)!, originalFilename: filenameMap.get(r.assetId)! }
      : null,
  }))
}

// ── Routes ────────────────────────────────────────────────────────────────────

const distributionRoutes: FastifyPluginAsync = async (fastify) => {

  // POST /distributions ───────────────────────────────────────────────────────
  fastify.post<{
    Body: { jobId: string; kind: string; config: Record<string, unknown> }
  }>('/distributions', { preHandler: requireAuth }, async (request, reply) => {
    const { jobId, kind, config } = request.body ?? {}
    const tenantId = request.tenantId!
    const userId = request.user!.id

    if (typeof jobId !== 'string' || !jobId) {
      return reply.code(400).send({ error: 'jobId is required' })
    }
    if (!isDestinationKind(kind)) {
      return reply.code(400).send({ error: `Invalid destination kind: ${String(kind)}` })
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      return reply.code(400).send({ error: 'config must be an object' })
    }

    const configError = validateConfig(kind, config)
    if (configError) return reply.code(400).send({ error: configError })

    // Verify job belongs to tenant and is completed
    const job = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx
        .select({ id: jobs.id, status: jobs.status, outputAssetId: jobs.outputAssetId })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1)
      return row
    })

    if (!job) return reply.code(404).send({ error: 'Job not found' })
    if (job.status !== 'completed') {
      return reply.code(400).send({
        error: `Job must be completed before distributing (current status: ${job.status})`,
      })
    }
    if (!job.outputAssetId) {
      return reply.code(400).send({ error: 'Job has no output asset to distribute' })
    }

    // Insert distribution row
    const [dist] = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      return tx
        .insert(distributions)
        .values({
          tenantId,
          jobId,
          assetId: job.outputAssetId!,
          destinationKind: kind,
          config,
          createdByUserId: userId,
        })
        .returning()
    })

    if (!dist) return reply.code(500).send({ error: 'Failed to create distribution' })

    // Enqueue
    await enqueueDistribution({ distributionId: dist.id, tenantId, kind })

    // Mark queued
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      await tx
        .update(distributions)
        .set({ status: 'queued', updatedAt: new Date() })
        .where(eq(distributions.id, dist.id))
    })

    return reply.code(201).send({ ...dist, status: 'queued' })
  })

  // GET /distributions ────────────────────────────────────────────────────────
  fastify.get<{
    Querystring: {
      jobId?: string
      kind?: string
      status?: string
      limit?: string
      cursor?: string
    }
  }>('/distributions', { preHandler: requireAuth }, async (request, reply) => {
    const tenantId = request.tenantId!
    const { jobId, kind, status, limit: limitStr, cursor } = request.query

    const limit = Math.min(parseInt(limitStr ?? '20', 10) || 20, 100)

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)

      const conditions = [eq(distributions.tenantId, tenantId)]

      if (jobId) conditions.push(eq(distributions.jobId, jobId))
      if (kind && isDestinationKind(kind)) conditions.push(eq(distributions.destinationKind, kind))
      if (status && isDistributionStatus(status)) conditions.push(eq(distributions.status, status))
      if (cursor) conditions.push(lt(distributions.createdAt, new Date(cursor)))

      return tx
        .select()
        .from(distributions)
        .where(and(...conditions))
        .orderBy(desc(distributions.createdAt))
        .limit(limit + 1)
    })

    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const nextCursor =
      hasMore && items.length > 0 ? items[items.length - 1]!.createdAt.toISOString() : null

    const enriched = await attachDistributionAsset(items, tenantId)

    return reply.send({ distributions: enriched, nextCursor })
  })

  // GET /distributions/:id ────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/distributions/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const tenantId = request.tenantId!
      const { id } = request.params

      const [dist] = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx.select().from(distributions).where(eq(distributions.id, id)).limit(1)
      })

      if (!dist) return reply.code(404).send({ error: 'Distribution not found' })

      const [enriched] = await attachDistributionAsset([dist], tenantId)
      return reply.send(enriched)
    },
  )

  // POST /distributions/:id/retry ─────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/distributions/:id/retry',
    { preHandler: requireAuth },
    async (request, reply) => {
      const tenantId = request.tenantId!
      const { id } = request.params

      const [dist] = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx.select().from(distributions).where(eq(distributions.id, id)).limit(1)
      })

      if (!dist) return reply.code(404).send({ error: 'Distribution not found' })
      if (dist.status !== 'failed') {
        return reply.code(400).send({
          error: `Can only retry failed distributions (current status: ${dist.status})`,
        })
      }

      await enqueueDistribution({
        distributionId: dist.id,
        tenantId,
        kind: dist.destinationKind,
      })

      const [updated] = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx
          .update(distributions)
          .set({
            status: 'queued',
            retries: 0,
            errorMessage: null,
            errorStack: null,
            updatedAt: new Date(),
          })
          .where(eq(distributions.id, id))
          .returning()
      })

      return reply.send(updated)
    },
  )

  // POST /distributions/:id/cancel ────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/distributions/:id/cancel',
    { preHandler: requireAuth },
    async (request, reply) => {
      const tenantId = request.tenantId!
      const { id } = request.params

      const [dist] = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx.select().from(distributions).where(eq(distributions.id, id)).limit(1)
      })

      if (!dist) return reply.code(404).send({ error: 'Distribution not found' })
      if (dist.status !== 'pending' && dist.status !== 'queued') {
        return reply.code(400).send({
          error: `Can only cancel pending or queued distributions (current status: ${dist.status})`,
        })
      }

      // Remove from BullMQ best-effort
      try {
        const queue = getDistributeQueue()
        const bullJob = await queue.getJob(id)
        if (bullJob) await bullJob.remove()
      } catch {
        // Non-fatal — DB status is the source of truth
      }

      const [updated] = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx
          .update(distributions)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(distributions.id, id))
          .returning()
      })

      return reply.send(updated)
    },
  )

  // DELETE /distributions/:id ─────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/distributions/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const tenantId = request.tenantId!
      const { id } = request.params

      const [dist] = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx.select().from(distributions).where(eq(distributions.id, id)).limit(1)
      })

      if (!dist) return reply.code(404).send({ error: 'Distribution not found' })

      const terminalStatuses = ['completed', 'failed', 'cancelled'] as const
      if (!(terminalStatuses as readonly string[]).includes(dist.status)) {
        return reply.code(400).send({
          error: `Can only delete terminal distributions. Cancel first (current status: ${dist.status})`,
        })
      }

      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        await tx.delete(distributions).where(eq(distributions.id, id))
      })

      return reply.code(204).send()
    },
  )

  // GET /tenant-settings/distribution ─────────────────────────────────────────
  fastify.get(
    '/tenant-settings/distribution',
    { preHandler: requireAuth },
    async (request, reply) => {
      const tenantId = request.tenantId!

      const [row] = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx
          .select({ value: tenantSettings.value })
          .from(tenantSettings)
          .where(
            and(
              eq(tenantSettings.tenantId, tenantId),
              eq(tenantSettings.key, 'distribution.auto_publish'),
            ),
          )
          .limit(1)
      })

      return reply.send({ auto_publish: Array.isArray(row?.value) ? row.value : [] })
    },
  )

  // PUT /tenant-settings/distribution ─────────────────────────────────────────
  fastify.put<{
    Body: {
      auto_publish: Array<{
        kind: string
        config: Record<string, unknown>
        on_kinds?: string[]
      }>
    }
  }>('/tenant-settings/distribution', { preHandler: requireAuth }, async (request, reply) => {
    const tenantId = request.tenantId!
    const { auto_publish } = request.body ?? {}

    if (!Array.isArray(auto_publish)) {
      return reply.code(400).send({ error: 'auto_publish must be an array' })
    }

    // Validate each entry
    for (let i = 0; i < auto_publish.length; i++) {
      const entry = auto_publish[i]!
      if (!isDestinationKind(entry.kind)) {
        return reply.code(400).send({ error: `auto_publish[${i}].kind is invalid: ${entry.kind}` })
      }
      if (typeof entry.config !== 'object' || entry.config === null || Array.isArray(entry.config)) {
        return reply.code(400).send({ error: `auto_publish[${i}].config must be an object` })
      }
      const configError = validateConfig(entry.kind as DestinationKind, entry.config)
      if (configError) return reply.code(400).send({ error: `auto_publish[${i}]: ${configError}` })
    }

    // Upsert into tenant_settings
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      await tx
        .insert(tenantSettings)
        .values({
          tenantId,
          key: 'distribution.auto_publish',
          value: auto_publish,
        })
        .onConflictDoUpdate({
          target: [tenantSettings.tenantId, tenantSettings.key],
          set: { value: auto_publish, updatedAt: new Date() },
        })
    })

    return reply.send({ auto_publish })
  })
}

export default fp(distributionRoutes, {
  name: 'distribution-routes',
  fastify: '4.x',
})
