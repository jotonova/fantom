import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../client.js'
import { shortsRenders } from '../schema/shorts-renders.js'
import type { ShortsRender } from '../schema/shorts-renders.js'

// ── Params ────────────────────────────────────────────────────────────────────

export type CreateShortsRenderParams = {
  tenantId: string
  briefId: string
  bullmqJobId?: string | null
  costEstimateUsd?: number | null
}

export type UpdateShortsRenderParams = Partial<{
  status: ShortsRender['status']
  bullmqJobId: string | null
  outputAssetId: string | null
  errorMessage: string | null
  startedAt: Date | null
  finishedAt: Date | null
  durationMs: number | null
  costEstimateUsd: number | null
  costActualUsd: number | null
}>

// ── Helpers ───────────────────────────────────────────────────────────────────

function numericOrNull(v: number | null | undefined): string | null {
  return v != null ? String(v) : null
}

// ── Repo functions ────────────────────────────────────────────────────────────

export async function createShortsRender(
  db: Db,
  params: CreateShortsRenderParams,
): Promise<ShortsRender> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${params.tenantId}, true)`)
    const [r] = await tx
      .insert(shortsRenders)
      .values({
        tenantId: params.tenantId,
        briefId: params.briefId,
        bullmqJobId: params.bullmqJobId ?? null,
        costEstimateUsd: numericOrNull(params.costEstimateUsd),
        status: 'queued',
      })
      .returning()
    return r
  })
  if (!row) throw new Error('Failed to create shorts render')
  return row
}

export async function getShortsRenderById(
  db: Db,
  id: string,
  tenantId: string,
): Promise<ShortsRender | null> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [r] = await tx.select().from(shortsRenders).where(eq(shortsRenders.id, id)).limit(1)
    return r
  })
  return row ?? null
}

export async function getLatestRenderForBrief(
  db: Db,
  briefId: string,
  tenantId: string,
): Promise<ShortsRender | null> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [r] = await tx
      .select()
      .from(shortsRenders)
      .where(and(eq(shortsRenders.briefId, briefId), eq(shortsRenders.tenantId, tenantId)))
      .orderBy(desc(shortsRenders.createdAt))
      .limit(1)
    return r
  })
  return row ?? null
}

export async function listRendersForBrief(
  db: Db,
  briefId: string,
  tenantId: string,
): Promise<ShortsRender[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    return tx
      .select()
      .from(shortsRenders)
      .where(and(eq(shortsRenders.briefId, briefId), eq(shortsRenders.tenantId, tenantId)))
      .orderBy(desc(shortsRenders.createdAt))
  })
}

export async function updateShortsRender(
  db: Db,
  id: string,
  tenantId: string,
  params: UpdateShortsRenderParams,
): Promise<ShortsRender | null> {
  const values: Partial<typeof shortsRenders.$inferInsert> = { updatedAt: new Date() }

  if ('status' in params) values.status = params.status
  if ('bullmqJobId' in params) values.bullmqJobId = params.bullmqJobId
  if ('outputAssetId' in params) values.outputAssetId = params.outputAssetId
  if ('errorMessage' in params) values.errorMessage = params.errorMessage
  if ('startedAt' in params) values.startedAt = params.startedAt ?? undefined
  if ('finishedAt' in params) values.finishedAt = params.finishedAt ?? undefined
  if ('durationMs' in params) values.durationMs = params.durationMs
  if ('costEstimateUsd' in params) values.costEstimateUsd = numericOrNull(params.costEstimateUsd)
  if ('costActualUsd' in params) values.costActualUsd = numericOrNull(params.costActualUsd)

  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [r] = await tx
      .update(shortsRenders)
      .set(values)
      .where(and(eq(shortsRenders.id, id), eq(shortsRenders.tenantId, tenantId)))
      .returning()
    return r
  })
  return row ?? null
}
