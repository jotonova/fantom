/**
 * AssemblyAI cost cap infrastructure.
 *
 * Provides budget checks and usage recording for transcription jobs.
 * All constants are exported so callers can surface them in UI/alerts.
 *
 * Cap model:
 *   DAILY_SOFT_CAP  — alert only (in-app notification via F9), never blocks
 *   DAILY_HARD_CAP  — hard block: rejects the transcription request
 *   MONTHLY_HARD_CAP — hard block: rejects the transcription request
 *
 * NOTE: Do NOT send Resend alerts from here — Resend is capacity-constrained.
 * Use checkSoftCapAlert() to detect crossing, then fire an in-app notification.
 */

import { db, assemblyaiUsage } from '@fantom/db'
import { and, desc, eq, gte, sql, sum } from 'drizzle-orm'

// ── Constants ─────────────────────────────────────────────────────────────────

export const DAILY_SOFT_CAP_USD = 10
export const DAILY_HARD_CAP_USD = 50
export const MONTHLY_HARD_CAP_USD = 100

/**
 * Universal-2 pricing: $0.37/hr (source: CheckThat.ai 2026).
 * Used to estimate cost before dispatching to AssemblyAI.
 */
export const COST_PER_SECOND_USD = 0.37 / 3600

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayStartUTC(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function thisMonthStartUTC(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Estimates transcription cost without making any DB calls.
 */
export function estimateTranscriptionCost(audioSeconds: number): number {
  return audioSeconds * COST_PER_SECOND_USD
}

/**
 * Returns today's (UTC) total spend in USD for the given tenant.
 */
export async function getDailySpendUsd(tenantId: string): Promise<number> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    await tx.execute(sql`SELECT set_config('app.is_platform_admin', 'true', true)`)
    const [r] = await tx
      .select({ total: sum(assemblyaiUsage.costUsd) })
      .from(assemblyaiUsage)
      .where(
        and(
          eq(assemblyaiUsage.tenantId, tenantId),
          gte(assemblyaiUsage.createdAt, todayStartUTC()),
        ),
      )
    return r
  })
  return row?.total != null ? Number(row.total) : 0
}

/**
 * Returns this month's (UTC) total spend in USD for the given tenant.
 */
export async function getMonthlySpendUsd(tenantId: string): Promise<number> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    await tx.execute(sql`SELECT set_config('app.is_platform_admin', 'true', true)`)
    const [r] = await tx
      .select({ total: sum(assemblyaiUsage.costUsd) })
      .from(assemblyaiUsage)
      .where(
        and(
          eq(assemblyaiUsage.tenantId, tenantId),
          gte(assemblyaiUsage.createdAt, thisMonthStartUTC()),
        ),
      )
    return r
  })
  return row?.total != null ? Number(row.total) : 0
}

/**
 * Checks whether a transcription of the given estimated cost is allowed.
 *
 * Blocks if:
 *   - daily spend + estimated cost would exceed DAILY_HARD_CAP_USD
 *   - monthly spend + estimated cost would exceed MONTHLY_HARD_CAP_USD
 *
 * The soft cap is informational only — use checkSoftCapAlert() separately.
 */
export async function checkCanTranscribe(
  tenantId: string,
  estimatedCostUsd: number,
): Promise<{
  allowed: boolean
  reason?: string
  dailySpend: number
  monthlySpend: number
  capHit?: 'daily_hard' | 'monthly_hard'
}> {
  const [dailySpend, monthlySpend] = await Promise.all([
    getDailySpendUsd(tenantId),
    getMonthlySpendUsd(tenantId),
  ])

  if (dailySpend + estimatedCostUsd > DAILY_HARD_CAP_USD) {
    return {
      allowed: false,
      reason: `Daily transcription hard cap exceeded ($${DAILY_HARD_CAP_USD} limit, $${dailySpend.toFixed(4)} spent today)`,
      dailySpend,
      monthlySpend,
      capHit: 'daily_hard',
    }
  }

  if (monthlySpend + estimatedCostUsd > MONTHLY_HARD_CAP_USD) {
    return {
      allowed: false,
      reason: `Monthly transcription hard cap exceeded ($${MONTHLY_HARD_CAP_USD} limit, $${monthlySpend.toFixed(4)} spent this month)`,
      dailySpend,
      monthlySpend,
      capHit: 'monthly_hard',
    }
  }

  return { allowed: true, dailySpend, monthlySpend }
}

/**
 * Records a completed transcription in assemblyai_usage and computes cost.
 * Non-optional — throws if the insert fails (caller should handle/log).
 */
export async function recordUsage(
  tenantId: string,
  assetId: string | null,
  audioSeconds: number,
  transcriptionId?: string,
  model?: string,
): Promise<void> {
  const costUsd = estimateTranscriptionCost(audioSeconds)
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    await tx.execute(sql`SELECT set_config('app.is_platform_admin', 'true', true)`)
    await tx.insert(assemblyaiUsage).values({
      tenantId,
      assetId: assetId ?? null,
      audioSeconds: String(audioSeconds),
      costUsd: String(costUsd),
      model: model ?? 'universal-2',
      transcriptionId: transcriptionId ?? null,
    })
  })
}

/**
 * Returns true if today's spend JUST crossed DAILY_SOFT_CAP_USD with the most
 * recently recorded row. Call this immediately after recordUsage() to decide
 * whether to fire an in-app alert.
 *
 * Crossing detection: total_today >= soft_cap AND (total_today - latest_cost) < soft_cap
 * This avoids firing the alert on every subsequent transcription after the cap is hit.
 */
export async function checkSoftCapAlert(tenantId: string): Promise<boolean> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    await tx.execute(sql`SELECT set_config('app.is_platform_admin', 'true', true)`)
    return tx
      .select({ costUsd: assemblyaiUsage.costUsd })
      .from(assemblyaiUsage)
      .where(
        and(
          eq(assemblyaiUsage.tenantId, tenantId),
          gte(assemblyaiUsage.createdAt, todayStartUTC()),
        ),
      )
      .orderBy(desc(assemblyaiUsage.createdAt))
  })

  if (rows.length === 0) return false

  const total = rows.reduce((acc, r) => acc + Number(r.costUsd), 0)
  if (total < DAILY_SOFT_CAP_USD) return false

  // Only fire on the crossing event, not on every row after
  const latestCost = Number(rows[0]!.costUsd)
  const prevTotal = total - latestCost
  return prevTotal < DAILY_SOFT_CAP_USD
}
