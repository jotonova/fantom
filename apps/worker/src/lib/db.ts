import { db, jobs, assets, voiceClones, tenants, tenantSettings } from '@fantom/db'
import type { Job as DbJob, Asset, VoiceClone } from '@fantom/db'
import { and, eq, sql } from 'drizzle-orm'

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

export async function createAssetRecord(params: {
  tenantId: string
  kind: 'audio' | 'video'
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
