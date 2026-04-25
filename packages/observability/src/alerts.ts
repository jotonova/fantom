import { and, eq, gte, sql } from 'drizzle-orm'
import { db, alertThrottle, tenants } from '@fantom/db'
import type { Event } from '@fantom/db'
import { Resend } from 'resend'

const FIVE_MINUTES_MS = 5 * 60 * 1000

function getDailyLimit(): number {
  return parseInt(process.env['FANTOM_DAILY_ALERT_LIMIT'] ?? '5', 10) || 5
}

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

export type AlertSkippedReason = 'not_configured' | 'daily_cap' | 'throttled' | 'send_failed'

export interface AlertResult {
  sent: boolean
  skippedReason?: AlertSkippedReason
}

/**
 * Throttled alert sender. Checks:
 * 1. Global daily cap across all tenants (hard stop against runaway loops)
 * 2. Per-tenant per-kind 5-minute cooldown (skipped for 'critical' severity)
 *
 * Returns an AlertResult describing whether the alert was sent and why it
 * was skipped if not — callers can surface this for debugging.
 *
 * If RESEND_API_KEY or ALERT_TO is not configured, returns immediately with
 * skippedReason: 'not_configured'.
 */
export async function maybeAlert(event: Event): Promise<AlertResult> {
  const apiKey = process.env['RESEND_API_KEY']
  const fromEmail =
    process.env['ALERT_FROM'] ?? 'Fantom Alerts <alerts@fantomvid.com>'
  const toRaw = process.env['ALERT_TO'] ?? ''
  const toEmails = toRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const dailyLimit = getDailyLimit()

  if (!apiKey || toEmails.length === 0) {
    console.warn(
      '[observability] RESEND_API_KEY or ALERT_TO not configured — skipping alert for:',
      event.kind,
    )
    return { sent: false, skippedReason: 'not_configured' }
  }

  const dayKey = getTodayKey()
  const tenantId = event.tenantId
  const kind = event.kind
  const isCritical = event.severity === 'critical'

  // ── 1. Global daily cap ───────────────────────────────────────────────────────
  try {
    const result = await db.execute<{ total: string }>(
      sql`SELECT COALESCE(SUM(alerts_sent_today), 0)::text AS total FROM alert_throttle WHERE day_key = ${dayKey}::date`,
    )
    const totalToday = parseInt(result.rows[0]?.total ?? '0', 10)
    if (totalToday >= dailyLimit) {
      console.log(
        `[observability] daily alert cap (${dailyLimit}) reached — skipping ${kind}`,
      )
      return { sent: false, skippedReason: 'daily_cap' }
    }
  } catch (err) {
    console.error('[observability] daily cap check failed:', err)
    return { sent: false, skippedReason: 'send_failed' }
  }

  // ── 2. Per-tenant per-kind 5-minute throttle (skipped for critical) ───────────
  if (tenantId && !isCritical) {
    try {
      const fiveMinAgo = new Date(Date.now() - FIVE_MINUTES_MS)
      const existing = await db
        .select({ id: alertThrottle.id })
        .from(alertThrottle)
        .where(
          and(
            eq(alertThrottle.tenantId, tenantId),
            eq(alertThrottle.eventKind, kind),
            eq(alertThrottle.dayKey, dayKey),
            gte(alertThrottle.lastAlertedAt, fiveMinAgo),
          ),
        )
        .limit(1)

      if (existing.length > 0) {
        console.log(
          `[observability] throttled (5min): ${kind} for tenant ${tenantId}`,
        )
        return { sent: false, skippedReason: 'throttled' }
      }
    } catch (err) {
      console.error('[observability] throttle check failed:', err)
      return { sent: false, skippedReason: 'send_failed' }
    }
  }

  // ── 3. Resolve tenant slug for context ────────────────────────────────────────
  let tenantSlug: string | null = null
  if (tenantId) {
    try {
      const [row] = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`,
        )
        return tx
          .select({ slug: tenants.slug })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1)
      })
      tenantSlug = row?.slug ?? null
    } catch {
      // non-fatal
    }
  }

  // ── 4. Build and send email ───────────────────────────────────────────────────
  const subject = `[Fantom ${event.severity.toUpperCase()}] ${kind} (tenant: ${tenantSlug ?? 'system'})`
  const adminLink = `https://fantomvid.com/admin?event=${event.id}`
  const meta = event.metadata as Record<string, unknown>

  const htmlBody = `
<h2 style="font-family:sans-serif;">Fantom Alert: ${kind}</h2>
<table style="font-family:monospace;border-collapse:collapse;" cellpadding="4">
  <tr><th align="left">Severity</th><td><strong>${event.severity.toUpperCase()}</strong></td></tr>
  <tr><th align="left">Kind</th><td>${kind}</td></tr>
  <tr><th align="left">Tenant</th><td>${tenantSlug ?? 'system'}</td></tr>
  ${event.subjectType ? `<tr><th align="left">Subject</th><td>${event.subjectType}${event.subjectId ? ` (${event.subjectId})` : ''}</td></tr>` : ''}
  ${event.errorMessage ? `<tr><th align="left">Error</th><td style="color:red;">${event.errorMessage}</td></tr>` : ''}
  <tr><th align="left">Time</th><td>${event.createdAt.toISOString()}</td></tr>
  <tr><th align="left">Event ID</th><td>${event.id}</td></tr>
</table>
${Object.keys(meta).length > 0 ? `<h3 style="font-family:sans-serif;">Metadata</h3><pre style="background:#f4f4f4;padding:8px;">${JSON.stringify(meta, null, 2)}</pre>` : ''}
<p style="font-family:sans-serif;"><a href="${adminLink}">View in Admin Dashboard →</a></p>
`

  try {
    const resend = new Resend(apiKey)
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: toEmails,
      subject,
      html: htmlBody,
    })

    if (error) {
      console.error('[observability] Resend send error:', error)
      return { sent: false, skippedReason: 'send_failed' }
    }

    // ── 5. Update throttle record ─────────────────────────────────────────────
    if (tenantId) {
      const now = new Date()
      await db
        .insert(alertThrottle)
        .values({
          tenantId,
          eventKind: kind,
          lastAlertedAt: now,
          alertsSentToday: 1,
          dayKey,
        })
        .onConflictDoUpdate({
          target: [alertThrottle.tenantId, alertThrottle.eventKind, alertThrottle.dayKey],
          set: {
            lastAlertedAt: now,
            alertsSentToday: sql`alert_throttle.alerts_sent_today + 1`,
          },
        })
    }

    console.log(`[observability] alert sent: ${subject}`)
    return { sent: true }
  } catch (err) {
    console.error('[observability] alert send failed:', err)
    return { sent: false, skippedReason: 'send_failed' }
  }
}
