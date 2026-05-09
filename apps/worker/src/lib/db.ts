import { db, jobs, assets, voiceClones, tenants, tenantSettings, distributions, shortsJobs, shortsRenders, shortsBriefs, brandKits, runwayUsage } from '@fantom/db'
import type { Job as DbJob, Asset, VoiceClone, Distribution, ShortsJob, ShortsRender, ShortsBrief, BrandKit } from '@fantom/db'
import type { DestinationKind } from '@fantom/distribution-bus'
import { and, eq, gte, inArray, lt, sql, sum } from 'drizzle-orm'

// ── Job helpers ────────────────────────────────────────────────────────────────

export async function getJobRow(jobId: string, tenantId: string): Promise<DbJob | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [row] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
    return row
  })
}

export async function patchJob(
  jobId: string,
  tenantId: string,
  values: Partial<typeof jobs.$inferInsert>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    await tx
      .update(jobs)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(jobs.id, jobId))
  })
}

export async function setProgress(jobId: string, tenantId: string, pct: number): Promise<void> {
  await patchJob(jobId, tenantId, { progress: Math.min(Math.max(0, pct), 100) })
}

// ── Asset helpers ──────────────────────────────────────────────────────────────

export async function getAssetRow(assetId: string, tenantId: string): Promise<Asset | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [row] = await tx.select().from(assets).where(eq(assets.id, assetId)).limit(1)
    return row
  })
}

export async function patchAsset(
  assetId: string,
  tenantId: string,
  values: Partial<typeof assets.$inferInsert>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    await tx
      .update(assets)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(assets.id, assetId))
  })
}

export async function createAssetRecord(params: {
  tenantId: string
  kind: 'audio' | 'video'
  source: 'upload' | 'rendered' | 'imported'
  r2Key: string
  originalFilename: string
  mimeType: string
  sizeBytes: number
  durationSeconds?: number | null
  width?: number | null
  height?: number | null
}): Promise<Asset> {
  const asset = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${params.tenantId}, true)`)
    const [row] = await tx
      .insert(assets)
      .values({
        tenantId: params.tenantId,
        uploadedByUserId: null,
        kind: params.kind,
        originalFilename: params.originalFilename,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
        r2Key: params.r2Key,
        durationSeconds:
          params.durationSeconds != null ? String(params.durationSeconds) : null,
        width: params.width ?? null,
        height: params.height ?? null,
        tags: [],
        metadata: { source: params.source },
      })
      .returning()
    return row
  })
  if (!asset) throw new Error('Failed to create asset record')
  return asset
}

// ── Voice clone helpers ────────────────────────────────────────────────────────

export async function getVoiceCloneRow(
  voiceCloneId: string,
  tenantId: string,
): Promise<VoiceClone | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [row] = await tx
      .select()
      .from(voiceClones)
      .where(eq(voiceClones.id, voiceCloneId))
      .limit(1)
    return row
  })
}

export async function patchVoiceClone(
  cloneId: string,
  tenantId: string,
  values: Partial<typeof voiceClones.$inferInsert>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    await tx
      .update(voiceClones)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(voiceClones.id, cloneId))
  })
}

// ── Tenant helpers ─────────────────────────────────────────────────────────────

export async function getTenantSlug(tenantId: string): Promise<string> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [r] = await tx
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
    return r
  })
  if (!row) throw new Error(`Tenant ${tenantId} not found`)
  return row.slug
}

/**
 * Reads the tenant's preferred render provider name from tenant_settings.
 * Key: 'render.preferred_provider' — value: { "name": "ffmpeg" }
 * Returns undefined if not set.
 */
export async function getPreferredProvider(tenantId: string): Promise<string | undefined> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [r] = await tx
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(
        and(
          eq(tenantSettings.tenantId, tenantId),
          eq(tenantSettings.key, 'render.preferred_provider'),
        ),
      )
      .limit(1)
    return r
  })

  if (!row?.value) return undefined
  const v = row.value as Record<string, unknown>
  return typeof v['name'] === 'string' ? v['name'] : undefined
}

// ── Auto-publish config ────────────────────────────────────────────────────────

export interface AutoPublishEntry {
  kind: DestinationKind
  config: Record<string, unknown>
  on_kinds?: string[]
}

/**
 * Reads the tenant's auto_publish config from tenant_settings.
 * Key: 'distribution.auto_publish' — value: AutoPublishEntry[]
 * Returns empty array if not set.
 */
export async function getAutoPublishConfig(tenantId: string): Promise<AutoPublishEntry[]> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [r] = await tx
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(
        and(
          eq(tenantSettings.tenantId, tenantId),
          eq(tenantSettings.key, 'distribution.auto_publish'),
        ),
      )
      .limit(1)
    return r
  })

  if (!Array.isArray(row?.value)) return []
  return row.value as AutoPublishEntry[]
}

// ── Distribution helpers ───────────────────────────────────────────────────────

export async function getDistributionRow(
  distributionId: string,
  tenantId: string,
): Promise<Distribution | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [row] = await tx
      .select()
      .from(distributions)
      .where(eq(distributions.id, distributionId))
      .limit(1)
    return row
  })
}

export async function patchDistribution(
  distributionId: string,
  tenantId: string,
  values: Partial<typeof distributions.$inferInsert>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    await tx
      .update(distributions)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(distributions.id, distributionId))
  })
}

// ── Shorts job helpers ─────────────────────────────────────────────────────────

export async function getShortsJobRow(
  shortsJobId: string,
  tenantId: string,
): Promise<ShortsJob | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [row] = await tx
      .select()
      .from(shortsJobs)
      .where(eq(shortsJobs.id, shortsJobId))
      .limit(1)
    return row
  })
}

export async function patchShortsJob(
  shortsJobId: string,
  tenantId: string,
  values: Partial<typeof shortsJobs.$inferInsert>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    await tx
      .update(shortsJobs)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(shortsJobs.id, shortsJobId))
  })
}

// ── Brand kit helpers ──────────────────────────────────────────────────────────

export async function getBrandKitRow(
  brandKitId: string,
  tenantId: string,
): Promise<BrandKit | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [row] = await tx
      .select()
      .from(brandKits)
      .where(eq(brandKits.id, brandKitId))
      .limit(1)
    return row
  })
}

// ── Distribution helpers ───────────────────────────────────────────────────────

export async function createDistributionRecord(params: {
  tenantId: string
  jobId: string
  assetId: string
  destinationKind: DestinationKind
  config: Record<string, unknown>
  createdByUserId?: string | null
}): Promise<Distribution> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${params.tenantId}, true)`)
    const [r] = await tx
      .insert(distributions)
      .values({
        tenantId: params.tenantId,
        jobId: params.jobId,
        assetId: params.assetId,
        destinationKind: params.destinationKind,
        config: params.config,
        createdByUserId: params.createdByUserId ?? null,
      })
      .returning()
    return r
  })
  if (!row) throw new Error('Failed to create distribution record')
  return row
}

// ── Shorts render helpers ──────────────────────────────────────────────────────

export async function getShortsRenderRow(
  renderId: string,
  tenantId: string,
): Promise<ShortsRender | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [row] = await tx
      .select()
      .from(shortsRenders)
      .where(eq(shortsRenders.id, renderId))
      .limit(1)
    return row
  })
}

export async function patchShortsRender(
  renderId: string,
  tenantId: string,
  values: Partial<typeof shortsRenders.$inferInsert>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    await tx
      .update(shortsRenders)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(shortsRenders.id, renderId))
  })
}

export async function patchShortsBrief(
  briefId: string,
  tenantId: string,
  values: Partial<typeof shortsBriefs.$inferInsert>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    await tx
      .update(shortsBriefs)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(shortsBriefs.id, briefId))
  })
}

export async function getShortsBriefRow(
  briefId: string,
  tenantId: string,
): Promise<typeof shortsBriefs.$inferSelect | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    const [row] = await tx.select().from(shortsBriefs).where(eq(shortsBriefs.id, briefId)).limit(1)
    return row
  })
}

/**
 * Fetches assets by IDs and returns them in the same order as `assetIds`.
 * Assets not found in the DB are silently omitted.
 */
export async function getAssetsInOrder(
  assetIds: string[],
  tenantId: string,
): Promise<Array<typeof assets.$inferSelect>> {
  if (assetIds.length === 0) return []
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    return tx.select().from(assets).where(inArray(assets.id, assetIds))
  })
  const byId = new Map(rows.map((r) => [r.id, r]))
  return assetIds.map((id) => byId.get(id)).filter((r): r is typeof assets.$inferSelect => r != null)
}

/**
 * Creates an asset record for a rendered shorts output.
 *
 * metadata.source is set to boolean `false` (NOT the string 'rendered') so the
 * SourceClipPicker — which filters on ?source=upload — never surfaces rendered
 * outputs as selectable clips. This is a hard guardrail: do not change without
 * also auditing the SourceClipPicker query.
 */
export async function createShortsRenderedAsset(params: {
  tenantId: string
  r2Key: string
  sizeBytes: number
  durationSeconds: number
  width?: number
  height?: number
  metadata?: Record<string, unknown>
}): Promise<Asset> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${params.tenantId}, true)`)
    const [r] = await tx
      .insert(assets)
      .values({
        tenantId: params.tenantId,
        uploadedByUserId: null,
        kind: 'video',
        originalFilename: 'output.mp4',
        mimeType: 'video/mp4',
        sizeBytes: params.sizeBytes,
        r2Key: params.r2Key,
        durationSeconds: String(params.durationSeconds),
        width: params.width ?? 1080,
        height: params.height ?? 1920,
        tags: [],
        metadata: { source: false, ...params.metadata },
      })
      .returning()
    return r
  })
  if (!row) throw new Error('Failed to create rendered asset record')
  return row
}

// ── Runway budget helpers ──────────────────────────────────────────────────────

export interface RunwayBudgetStatus {
  available: boolean
  spentUsd: number
  capUsd: number
  resetsAt: Date
}

/**
 * Checks how much of the tenant's Runway monthly budget has been spent.
 * Cap is read from RUNWAY_MONTHLY_CAP_USD env var (default $100).
 * Both GUCs must be set so the INSERT path (which returns) works correctly.
 *
 * Budget enforcement model:
 *   - Called BEFORE each Runway API call (per asset, inside batchProcess).
 *   - A single 5-second Gen-3 Turbo clip costs ~$0.50. If spentUsd is $99.51
 *     and the next clip would push the total to $100.01, the check fires and
 *     BudgetExceededError is thrown before the API call is made.
 *   - This is a "hard stop before dispatch" approach — no over-run is possible
 *     unless Runway changes its per-clip cost above RUNWAY_MONTHLY_CAP_USD.
 *   - The caller in multiModalRenderProvider wraps individual assets; remaining
 *     assets in the same batch will also be blocked once the cap is hit because
 *     each asset calls this function independently.
 */
export async function checkRunwayBudget(tenantId: string): Promise<RunwayBudgetStatus> {
  const capUsd = Number(process.env['RUNWAY_MONTHLY_CAP_USD'] ?? '100')

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    await tx.execute(sql`SELECT set_config('app.is_platform_admin', 'true', true)`)
    const [r] = await tx
      .select({ total: sum(runwayUsage.costUsd) })
      .from(runwayUsage)
      .where(
        and(
          eq(runwayUsage.tenantId, tenantId),
          gte(runwayUsage.billedAt, monthStart),
          lt(runwayUsage.billedAt, monthEnd),
        ),
      )
    return r
  })

  const spentUsd = row?.total != null ? Number(row.total) : 0
  return { available: spentUsd < capUsd, spentUsd, capUsd, resetsAt: monthEnd }
}

/**
 * Records a Runway usage entry. Non-skippable — throws if the insert fails.
 * Both GUCs are set so the INSERT…RETURNING path works under RLS.
 */
export async function recordRunwayUsage(params: {
  tenantId: string
  shortsJobId: string | null
  assetId: string
  taskId: string
  creditsUsed: number
  costUsd: number
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${params.tenantId}, true)`)
    await tx.execute(sql`SELECT set_config('app.is_platform_admin', 'true', true)`)
    await tx.insert(runwayUsage).values({
      tenantId: params.tenantId,
      shortsJobId: params.shortsJobId,
      assetId: params.assetId,
      taskId: params.taskId,
      creditsUsed: params.creditsUsed,
      costUsd: String(params.costUsd),
    })
  })
}
