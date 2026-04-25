import { db, events } from '@fantom/db'
import { sql } from 'drizzle-orm'
import { maybeAlert } from './alerts.js'
import type { AlertResult } from './alerts.js'

export type EventSeverity = 'debug' | 'info' | 'warn' | 'error' | 'critical'

export interface LogEventParams {
  tenantId?: string | null
  kind: string
  severity?: EventSeverity
  actorUserId?: string | null
  subjectType?: string | null
  subjectId?: string | null
  metadata?: Record<string, unknown>
  errorMessage?: string | null
  errorStack?: string | null
}

export interface LogEventResult {
  eventId: string
  alertAttempted: boolean
  alertResult: AlertResult | null
}

/**
 * Fire-and-forget structured event logger.
 * Never throws — if the DB insert fails it logs to stderr and continues.
 * Automatically triggers maybeAlert() for error/critical severity.
 */
export function logEvent(params: LogEventParams): void {
  _insert(params).catch((err) => {
    console.error('[observability] logEvent failed:', err)
  })
}

/**
 * Awaitable variant of logEvent — same pipeline, returns the event ID and
 * alert result. Use this when the caller needs to surface the outcome (e.g.
 * the POST /admin/alerts/test endpoint). Propagates errors rather than
 * swallowing them.
 */
export async function logEventAwaitable(params: LogEventParams): Promise<LogEventResult> {
  return _insert(params)
}

async function _insert(params: LogEventParams): Promise<LogEventResult> {
  const severity = params.severity ?? 'info'
  const tenantId = params.tenantId ?? null

  const values = {
    tenantId,
    kind: params.kind,
    severity,
    actorUserId: params.actorUserId ?? null,
    subjectType: params.subjectType ?? null,
    subjectId: params.subjectId ?? null,
    metadata: params.metadata ?? {},
    errorMessage: params.errorMessage ?? null,
    errorStack: params.errorStack ?? null,
  }

  let inserted: (typeof events.$inferSelect) | undefined

  // All inserts run in a single transaction that sets two LOCAL GUCs:
  //
  // 1. app.current_tenant_id — satisfies the INSERT policy's WITH CHECK condition
  //    (tenant_id IS NULL OR tenant_id::text = current_setting(...)).
  //
  // 2. app.is_platform_admin = 'true' — satisfies the SELECT policy used by
  //    RETURNING. PostgreSQL 16+ evaluates SELECT policies against rows returned
  //    by INSERT...RETURNING. Without this, null-tenant events and error/critical
  //    tenant events (filtered out by events_tenant_select) would fail with 42501.
  //    The GUC is transaction-LOCAL so it resets on commit and never leaks.
  const [row] = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_tenant_id', ${tenantId ?? ''}, true),
               set_config('app.is_platform_admin', 'true', true)`,
    )
    return tx.insert(events).values(values).returning()
  })
  inserted = row

  if (!inserted) {
    throw new Error('[observability] event insert returned no row')
  }

  if (severity === 'error' || severity === 'critical') {
    const alertResult = await maybeAlert(inserted)
    return { eventId: inserted.id, alertAttempted: true, alertResult }
  }

  return { eventId: inserted.id, alertAttempted: false, alertResult: null }
}
