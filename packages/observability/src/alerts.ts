import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db, tenants } from '@fantom/db'
import type { Event } from '@fantom/db'
import { Resend } from 'resend'

function getDailyLimit(): number {
  return parseInt(process.env['FANTOM_DAILY_ALERT_LIMIT'] ?? '5', 10) || 5
}

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

/** 1-hour dedupe window (ms). */
const DEDUPE_WINDOW_MS = 60 * 60 * 1000

export type AlertSkippedReason = 'not_configured' | 'daily_cap' | 'throttled' | 'send_failed'

export interface AlertResult {
  sent: boolean
  skippedReason?: AlertSkippedReason
}

/**
 * Throttled + deduplicated alert sender.
 *
 * Two independent gates run in order before an email is dispatched:
 *
 * 1. **Throttle gate** (existing): atomic INSERT…ON CONFLICT limits to one alert
 *    per 5-minute window per (tenant, kind) pair, plus a per-tenant daily cap.
 *    Critical-severity events skip the 5-minute cooldown but still respect the cap.
 *
 * 2. **Dedupe gate** (new): atomic INSERT…ON CONFLICT prevents the *same* alert
 *    content from re-firing within a 1-hour window. Dedupe key is
 *    sha256(tenantId|kind|severity|subjectType). Suppressed duplicates are counted;
 *    when the window resets the next email prepends "(N duplicates suppressed)".
 *
 * For system events (tenant_id IS NULL): both gates are skipped — system events
 * are low-volume admin smoke tests, not production alerts.
 */
export async function maybeAlert(event: Event): Promise<AlertResult> {
  const apiKey = process.env['RESEND_API_KEY']
  const fromEmail = process.env['ALERT_FROM'] ?? 'Fantom Alerts <alerts@fantomvid.com>'
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

  const tenantId = event.tenantId
  const kind = event.kind
  const isCritical = event.severity === 'critical'

  // ── Gate 1: Throttle ──────────────────────────────────────────────────────────

  if (tenantId) {
    // Tenant-scoped events: atomic throttle gate via INSERT...ON CONFLICT.
    //
    // The UPDATE only fires when the throttle conditions pass:
    //   - non-critical: outside the 5-minute cooldown window AND under daily cap
    //   - critical: only under daily cap (no cooldown — critical must get through fast)
    //
    // If UPDATE WHERE fails (conditions not met), no row is returned → skip.
    // If INSERT succeeds (first alert today) or UPDATE fires → proceed to send.
    //
    // This eliminates the read-then-write race: all concurrent callers attempt the
    // same upsert; only one can win the UPDATE WHERE race; others see 0 rows returned.
    try {
      const throttleResult = await db.execute<{ alerts_sent_today: number }>(
        isCritical
          ? sql`
              INSERT INTO alert_throttle (tenant_id, event_kind, day_key, last_alerted_at, alerts_sent_today)
              VALUES (${tenantId}, ${kind}, CURRENT_DATE, NOW(), 1)
              ON CONFLICT (tenant_id, event_kind, day_key) DO UPDATE
                SET last_alerted_at = EXCLUDED.last_alerted_at,
                    alerts_sent_today = alert_throttle.alerts_sent_today + 1
                WHERE alert_throttle.alerts_sent_today < ${dailyLimit}
              RETURNING alerts_sent_today
            `
          : sql`
              INSERT INTO alert_throttle (tenant_id, event_kind, day_key, last_alerted_at, alerts_sent_today)
              VALUES (${tenantId}, ${kind}, CURRENT_DATE, NOW(), 1)
              ON CONFLICT (tenant_id, event_kind, day_key) DO UPDATE
                SET last_alerted_at = EXCLUDED.last_alerted_at,
                    alerts_sent_today = alert_throttle.alerts_sent_today + 1
                WHERE alert_throttle.last_alerted_at < NOW() - INTERVAL '5 minutes'
                  AND alert_throttle.alerts_sent_today < ${dailyLimit}
              RETURNING alerts_sent_today
            `,
      )

      if (throttleResult.rows.length === 0) {
        // UPDATE WHERE failed → we're throttled or at the daily cap.
        // Do a follow-up read to distinguish the two for accurate reporting.
        const reasonResult = await db.execute<{ skip_reason: string }>(sql`
          SELECT
            CASE WHEN alerts_sent_today >= ${dailyLimit} THEN 'daily_cap' ELSE 'throttled' END AS skip_reason
          FROM alert_throttle
          WHERE tenant_id = ${tenantId} AND event_kind = ${kind} AND day_key = CURRENT_DATE
        `)
        const skippedReason = (reasonResult.rows[0]?.skip_reason ?? 'throttled') as AlertSkippedReason
        console.log(`[observability] ${skippedReason}: ${kind} for tenant ${tenantId}`)
        return { sent: false, skippedReason }
      }
      // Row returned → we won the upsert race, proceed to Gate 2.
    } catch (err) {
      console.error('[observability] throttle upsert failed:', err)
      return { sent: false, skippedReason: 'send_failed' }
    }
  } else {
    // System events (null tenant_id): alert_throttle requires non-null tenant_id,
    // so per-kind atomic throttling isn't available. Fall back to a coarse global
    // daily cap check. This is intentionally racy — system events are low-volume
    // (admin smoke tests, pre-tenant auth failures) and not production-critical.
    try {
      const dayKey = getTodayKey()
      const result = await db.execute<{ total: string }>(
        sql`SELECT COALESCE(SUM(alerts_sent_today), 0)::text AS total FROM alert_throttle WHERE day_key = ${dayKey}::date`,
      )
      const totalToday = parseInt(result.rows[0]?.total ?? '0', 10)
      if (totalToday >= dailyLimit) {
        console.log(`[observability] daily alert cap (${dailyLimit}) reached — skipping ${kind}`)
        return { sent: false, skippedReason: 'daily_cap' }
      }
    } catch (err) {
      console.error('[observability] daily cap check failed:', err)
      return { sent: false, skippedReason: 'send_failed' }
    }
  }

  // ── Gate 2: Dedupe (1-hour window, tenant-scoped only) ────────────────────────

  let prevSuppressedCount = 0

  if (tenantId) {
    // Dedupe key: sha256(tenantId|kind|severity|subjectType).
    // Excludes subjectId, message, and metadata — those vary per occurrence.
    const dedupeKey = createHash('sha256')
      .update(`${tenantId}|${kind}|${event.severity}|${event.subjectType ?? ''}`)
      .digest('hex')

    try {
      // Atomic UPSERT encodes the full decision tree in a single round-trip:
      //
      //   IN window  → suppressed_count += 1, last_sent_at unchanged → SUPPRESS
      //   OUT of window → prev_suppressed_count = old count, suppressed_count = 0,
      //                   last_sent_at = NOW()                          → SEND
      //   New row   → suppressed_count = 0, last_sent_at = NOW()       → SEND
      //
      // prev_suppressed_count preserves the window's accumulated suppression count
      // so the outgoing "reset" email can announce how many were suppressed.
      const dedupeResult = await db.execute<{
        suppressed_count: number
        prev_suppressed_count: number
      }>(sql`
        INSERT INTO alert_dedupe
          (tenant_id, dedupe_key, last_sent_at, suppressed_count, prev_suppressed_count)
        VALUES
          (${tenantId}, ${dedupeKey}, NOW(), 0, 0)
        ON CONFLICT ON CONSTRAINT alert_dedupe_tenant_key DO UPDATE
          SET
            prev_suppressed_count = CASE
              WHEN alert_dedupe.last_sent_at > NOW() - INTERVAL '1 hour'
                THEN alert_dedupe.prev_suppressed_count
                ELSE alert_dedupe.suppressed_count
              END,
            suppressed_count = CASE
              WHEN alert_dedupe.last_sent_at > NOW() - INTERVAL '1 hour'
                THEN alert_dedupe.suppressed_count + 1
                ELSE 0
              END,
            last_sent_at = CASE
              WHEN alert_dedupe.last_sent_at > NOW() - INTERVAL '1 hour'
                THEN alert_dedupe.last_sent_at
                ELSE NOW()
              END
        RETURNING suppressed_count, prev_suppressed_count
      `)

      const dedupeRow = dedupeResult.rows[0]
      if (dedupeRow && dedupeRow.suppressed_count > 0) {
        // suppressed_count was incremented → we're inside the cooldown window.
        console.log(
          `[observability] dedupe suppressed (${dedupeRow.suppressed_count} this window): ${kind}`,
        )
        return { sent: false, skippedReason: 'throttled' }
      }
      // suppressed_count = 0 → new row or window reset → proceed to send.
      prevSuppressedCount = dedupeRow?.prev_suppressed_count ?? 0
    } catch (err) {
      // Non-fatal: dedupe failure should not block alert delivery.
      console.error('[observability] dedupe upsert failed (non-fatal):', err)
    }
  }

  // ── Resolve tenant slug ───────────────────────────────────────────────────────
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

  // ── Build and send email ──────────────────────────────────────────────────────
  const subject = `[Fantom ${event.severity.toUpperCase()}] ${kind} (tenant: ${tenantSlug ?? 'system'})`
  const adminLink = `https://fantomvid.com/admin?event=${event.id}`
  const meta = event.metadata as Record<string, unknown>

  const suppressionBanner =
    prevSuppressedCount > 0
      ? `<p style="font-family:sans-serif;background:#fff3cd;border:1px solid #ffc107;padding:8px 12px;border-radius:4px;">
           <strong>${prevSuppressedCount} duplicate${prevSuppressedCount === 1 ? '' : 's'} suppressed in the last hour.</strong>
         </p>`
      : ''

  const htmlBody = `
${suppressionBanner}
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

    console.log(`[observability] alert sent: ${subject}`)
    return { sent: true }
  } catch (err) {
    console.error('[observability] alert send failed:', err)
    return { sent: false, skippedReason: 'send_failed' }
  }
}
