import { db, events } from '@fantom/db'
import { sql } from 'drizzle-orm'
import { maybeAlert } from './alerts.js'

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

/**
 * Fire-and-forget structured event logger.
 * Never throws — if the DB insert fails it logs to stderr and continues.
 * Automatically triggers maybeAlert() for error/critical severity.
 */
export function logEvent(params: LogEventParams): void {
  void _insert(params)
}

async function _insert(params: LogEventParams): Promise<void> {
  try {
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

    if (tenantId) {
      // Tenant-scoped insert: set GUC so the INSERT RLS policy has context.
      // The INSERT policy uses WITH CHECK (true) so the GUC is not strictly
      // required for the insert itself, but it's consistent with the rest of the codebase.
      const [row] = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx.insert(events).values(values).returning()
      })
      inserted = row
    } else {
      // System event with no tenant context (e.g. auth.login.failed before tenant resolves).
      // The INSERT policy WITH CHECK (true) allows this.
      const [row] = await db.insert(events).values(values).returning()
      inserted = row
    }

    if (inserted && (severity === 'error' || severity === 'critical')) {
      await maybeAlert(inserted).catch((alertErr) => {
        console.error('[observability] maybeAlert failed:', alertErr)
      })
    }
  } catch (err) {
    // Logging must never throw — degrade gracefully to stderr.
    console.error('[observability] logEvent failed:', err)
  }
}
