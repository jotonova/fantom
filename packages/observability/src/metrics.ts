import { and, count, eq, gte, lt, sql, sum } from 'drizzle-orm'
import { db, jobs, distributions, assets, events, tenants } from '@fantom/db'

/**
 * Runs all metrics queries in a transaction with app.is_platform_admin = 'true'
 * so the admin SELECT policies allow cross-tenant aggregation.
 */
async function withAdminCtx<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.is_platform_admin', 'true', true)`)
    return fn(tx as unknown as typeof db)
  })
}

/**
 * Runs a metrics query scoped to a single tenant.
 */
async function withTenantCtx<T>(tenantId: string, fn: (tx: typeof db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    return fn(tx as unknown as typeof db)
  })
}

export interface JobStatusCounts {
  pending: number
  queued: number
  processing: number
  completed: number
  failed: number
  cancelled: number
}

export interface DistributionStatusCounts {
  pending: number
  queued: number
  processing: number
  completed: number
  failed: number
  cancelled: number
}

export interface MetricsSnapshot {
  jobsByStatus: JobStatusCounts
  distributionsByStatus: DistributionStatusCounts
  avgRenderDurationSeconds: number | null
  errorRateLast24h: number | null
  elevenLabsCharsThisMonth: number
  r2StorageBytesUsed: number
  distinctActiveTenantsLast7d: number | null
}

function zeroJobCounts(): JobStatusCounts {
  return { pending: 0, queued: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 }
}

function zeroDistCounts(): DistributionStatusCounts {
  return { pending: 0, queued: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 }
}

/**
 * Returns a metrics snapshot.
 * - If tenantId is provided: scoped to that tenant.
 * - If tenantId is null: cross-tenant (platform admin only — uses admin GUC).
 */
export async function getMetricsSnapshot(opts: {
  tenantId?: string | null
  since?: Date
}): Promise<MetricsSnapshot> {
  const { tenantId } = opts
  const now = new Date()
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const ctx = tenantId
    ? (fn: (tx: typeof db) => Promise<unknown>) => withTenantCtx(tenantId, fn)
    : (fn: (tx: typeof db) => Promise<unknown>) => withAdminCtx(fn)

  // ── Jobs by status ─────────────────────────────────────────────────────────
  const jobsByStatus = await ctx(async (tx) => {
    const rows = await (tx as typeof db)
      .select({ status: jobs.status, cnt: count() })
      .from(jobs)
      .where(tenantId ? eq(jobs.tenantId, tenantId) : sql`true`)
      .groupBy(jobs.status)
    const counts = zeroJobCounts()
    for (const r of rows) {
      const s = r.status as keyof JobStatusCounts
      if (s in counts) counts[s] = Number(r.cnt)
    }
    return counts
  }) as JobStatusCounts

  // ── Distributions by status ────────────────────────────────────────────────
  const distributionsByStatus = await ctx(async (tx) => {
    const rows = await (tx as typeof db)
      .select({ status: distributions.status, cnt: count() })
      .from(distributions)
      .where(tenantId ? eq(distributions.tenantId, tenantId) : sql`true`)
      .groupBy(distributions.status)
    const counts = zeroDistCounts()
    for (const r of rows) {
      const s = r.status as keyof DistributionStatusCounts
      if (s in counts) counts[s] = Number(r.cnt)
    }
    return counts
  }) as DistributionStatusCounts

  // ── Avg render duration (last 24h) ─────────────────────────────────────────
  const avgRenderDurationSeconds = await ctx(async (tx) => {
    const rows = await (tx as typeof db).execute<{ avg_seconds: string | null }>(
      sql`SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at)))::text AS avg_seconds
          FROM jobs
          WHERE status = 'completed'
            AND completed_at >= ${last24h}
            ${tenantId ? sql`AND tenant_id = ${tenantId}::uuid` : sql``}`,
    )
    const raw = rows.rows[0]?.avg_seconds
    return raw != null ? Math.round(parseFloat(raw) * 10) / 10 : null
  }) as number | null

  // ── Error rate (last 24h) ──────────────────────────────────────────────────
  const errorRateLast24h = await (async () => {
    try {
      return await ctx(async (tx) => {
        const rows = await (tx as typeof db).execute<{
          total: string
          errors: string
        }>(
          sql`SELECT COUNT(*)::text AS total,
                     SUM(CASE WHEN severity IN ('error', 'critical') THEN 1 ELSE 0 END)::text AS errors
              FROM events
              WHERE created_at >= ${last24h}
                ${tenantId ? sql`AND tenant_id = ${tenantId}::uuid` : sql``}`,
        )
        const row = rows.rows[0]
        if (!row) return null
        const total = parseInt(row.total, 10)
        const errors = parseInt(row.errors, 10)
        if (total === 0) return 0
        return Math.round((errors / total) * 1000) / 10 // percent, 1 decimal
      }) as number | null
    } catch {
      return null
    }
  })()

  // ── ElevenLabs chars this month ────────────────────────────────────────────
  const elevenLabsCharsThisMonth = await (async () => {
    try {
      return await ctx(async (tx) => {
        const rows = await (tx as typeof db).execute<{ total: string }>(
          sql`SELECT COALESCE(SUM((metadata->>'characters')::bigint), 0)::text AS total
              FROM events
              WHERE kind = 'voice.synthesized'
                AND created_at >= ${monthStart}
                ${tenantId ? sql`AND tenant_id = ${tenantId}::uuid` : sql``}`,
        )
        return parseInt(rows.rows[0]?.total ?? '0', 10)
      }) as number
    } catch {
      return 0
    }
  })()

  // ── R2 storage bytes used ──────────────────────────────────────────────────
  const r2StorageBytesUsed = await ctx(async (tx) => {
    const rows = await (tx as typeof db)
      .select({ total: sum(assets.sizeBytes) })
      .from(assets)
      .where(tenantId ? eq(assets.tenantId, tenantId) : sql`true`)
    const raw = rows[0]?.total
    return raw != null ? Number(raw) : 0
  }) as number

  // ── Distinct active tenants last 7d (cross-tenant only) ───────────────────
  const distinctActiveTenantsLast7d = await (async () => {
    if (tenantId) return null // meaningless for single-tenant view
    try {
      return await withAdminCtx(async (tx) => {
        const rows = await (tx as typeof db).execute<{ cnt: string }>(
          sql`SELECT COUNT(DISTINCT tenant_id)::text AS cnt
              FROM events
              WHERE created_at >= ${last7d}
                AND tenant_id IS NOT NULL`,
        )
        return parseInt(rows.rows[0]?.cnt ?? '0', 10)
      }) as number
    } catch {
      return null
    }
  })()

  return {
    jobsByStatus,
    distributionsByStatus,
    avgRenderDurationSeconds,
    errorRateLast24h,
    elevenLabsCharsThisMonth,
    r2StorageBytesUsed,
    distinctActiveTenantsLast7d,
  }
}

/**
 * Returns a minimal summary suitable for the /admin/tenants list.
 */
export interface TenantSummary {
  id: string
  slug: string
  name: string
  jobsCompleted: number
  jobsFailed: number
  lastActivityAt: Date | null
}

export async function getAllTenantSummaries(): Promise<TenantSummary[]> {
  return withAdminCtx(async (tx): Promise<TenantSummary[]> => {
    const tenantRows = await (tx as typeof db)
      .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
      .from(tenants)
      .orderBy(tenants.name)

    const summaries: TenantSummary[] = []

    for (const t of tenantRows) {
      const jobRows = await (tx as typeof db)
        .select({ status: jobs.status, cnt: count() })
        .from(jobs)
        .where(and(eq(jobs.tenantId, t.id)))
        .groupBy(jobs.status)

      let jobsCompleted = 0
      let jobsFailed = 0
      for (const r of jobRows) {
        if (r.status === 'completed') jobsCompleted = Number(r.cnt)
        if (r.status === 'failed') jobsFailed = Number(r.cnt)
      }

      const lastActivityRows = await (tx as typeof db).execute<{ last: string | null }>(
        sql`SELECT MAX(created_at)::text AS last FROM events WHERE tenant_id = ${t.id}::uuid`,
      )
      const lastRaw = lastActivityRows.rows[0]?.last
      const lastActivityAt = lastRaw ? new Date(lastRaw) : null

      summaries.push({
        id: t.id,
        slug: t.slug,
        name: t.name,
        jobsCompleted,
        jobsFailed,
        lastActivityAt,
      })
    }

    return summaries
  })
}
