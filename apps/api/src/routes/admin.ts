import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, events, tenants } from '@fantom/db'
import { checkStorageHealth } from '@fantom/storage'
import { Redis } from 'ioredis'
import { getMetricsSnapshot, getAllTenantSummaries, logEventAwaitable } from '@fantom/observability'
import { requirePlatformAdmin } from '../plugins/admin-auth.js'

// ── Helper: set admin GUC in a transaction ────────────────────────────────────

async function withAdminCtx<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.is_platform_admin', 'true', true)`)
    return fn(tx as unknown as typeof db)
  })
}

// ── Routes ────────────────────────────────────────────────────────────────────

const adminRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /admin/metrics ─────────────────────────────────────────────────────────
  fastify.get('/admin/metrics', { preHandler: requirePlatformAdmin }, async (_request, reply) => {
    const snapshot = await getMetricsSnapshot({ tenantId: null })
    return reply.send(snapshot)
  })

  // GET /admin/events ──────────────────────────────────────────────────────────
  fastify.get<{
    Querystring: {
      tenantId?: string
      severity?: string
      kind?: string
      since?: string
      limit?: string
      cursor?: string
    }
  }>('/admin/events', { preHandler: requirePlatformAdmin }, async (request, reply) => {
    const { tenantId, severity, kind, since, limit: limitStr, cursor } = request.query
    const limit = Math.min(parseInt(limitStr ?? '50', 10) || 50, 200)

    const rows = await withAdminCtx(async (tx) => {
      const conditions = []

      if (tenantId) conditions.push(eq(events.tenantId, tenantId))
      if (severity) conditions.push(eq(events.severity, severity as 'debug' | 'info' | 'warn' | 'error' | 'critical'))
      if (kind) conditions.push(eq(events.kind, kind))
      if (since) conditions.push(gte(events.createdAt, new Date(since)))
      if (cursor) conditions.push(lt(events.createdAt, new Date(cursor)))

      return (tx as typeof db)
        .select()
        .from(events)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(events.createdAt))
        .limit(limit + 1)
    })

    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const nextCursor =
      hasMore && items.length > 0 ? items[items.length - 1]!.createdAt.toISOString() : null

    // Strip error_stack from list view — exposed only via GET /admin/events/:id
    const sanitized = items.map(({ errorStack: _s, ...rest }) => rest)

    return reply.send({ events: sanitized, nextCursor })
  })

  // GET /admin/events/:id ──────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/admin/events/:id',
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const { id } = request.params

      const [event] = await withAdminCtx(async (tx) => {
        return (tx as typeof db)
          .select()
          .from(events)
          .where(eq(events.id, id))
          .limit(1)
      })

      if (!event) return reply.code(404).send({ error: 'Event not found' })
      return reply.send(event) // includes error_stack for admin
    },
  )

  // GET /admin/tenants ──────────────────────────────────────────────────────────
  fastify.get('/admin/tenants', { preHandler: requirePlatformAdmin }, async (_request, reply) => {
    const summaries = await getAllTenantSummaries()
    return reply.send({ tenants: summaries })
  })

  // GET /admin/health ───────────────────────────────────────────────────────────
  fastify.get('/admin/health', { preHandler: requirePlatformAdmin }, async (_request, reply) => {
    const checks: Record<string, { healthy: boolean; latencyMs?: number; error?: string }> = {}

    // DB check
    const dbStart = Date.now()
    try {
      await db.execute(sql`SELECT 1`)
      checks['db'] = { healthy: true, latencyMs: Date.now() - dbStart }
    } catch (err) {
      checks['db'] = {
        healthy: false,
        latencyMs: Date.now() - dbStart,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    // Redis check
    const redisUrl = process.env['REDIS_URL']
    const redisStart = Date.now()
    if (redisUrl) {
      let redisClient: Redis | null = null
      try {
        redisClient = new Redis(redisUrl, {
          maxRetriesPerRequest: 1,
          connectTimeout: 3000,
          enableReadyCheck: false,
          lazyConnect: true,
        })
        await redisClient.connect()
        await redisClient.ping()
        checks['redis'] = { healthy: true, latencyMs: Date.now() - redisStart }
      } catch (err) {
        checks['redis'] = {
          healthy: false,
          latencyMs: Date.now() - redisStart,
          error: err instanceof Error ? err.message : String(err),
        }
      } finally {
        redisClient?.disconnect()
      }
    } else {
      checks['redis'] = { healthy: false, error: 'REDIS_URL not configured' }
    }

    // R2 check — use @fantom/storage's built-in health check
    const r2Start = Date.now()
    const r2Result = await checkStorageHealth()
    if (r2Result.healthy) {
      checks['r2'] = { healthy: true, latencyMs: Date.now() - r2Start }
    } else {
      checks['r2'] = {
        healthy: false,
        latencyMs: Date.now() - r2Start,
        ...(r2Result.error !== undefined ? { error: r2Result.error } : {}),
      }
    }

    // Resend check — verify API key is configured
    const resendKey = process.env['RESEND_API_KEY']
    if (resendKey) {
      checks['resend'] = { healthy: true }
    } else {
      checks['resend'] = { healthy: false, error: 'RESEND_API_KEY not configured' }
    }

    // ElevenLabs check — verify API key is configured
    const elKey = process.env['ELEVENLABS_API_KEY']
    if (elKey) {
      checks['elevenlabs'] = { healthy: true }
    } else {
      checks['elevenlabs'] = { healthy: false, error: 'ELEVENLABS_API_KEY not configured' }
    }

    const healthy = Object.values(checks).every((c) => c.healthy)
    return reply.send({ services: checks, healthy, timestamp: new Date().toISOString() })
  })

  // POST /admin/alerts/test ────────────────────────────────────────────────────
  // Fires a synthetic event through the real logEvent + maybeAlert pipeline and
  // returns a structured result explaining whether an alert was sent and why not
  // if it was skipped. Useful for smoke-testing the email alert path end-to-end.
  fastify.post<{
    Body: {
      severity?: 'error' | 'critical'
      kind?: string
      message?: string
    }
  }>('/admin/alerts/test', { preHandler: requirePlatformAdmin }, async (request, reply) => {
    const severity = request.body?.severity ?? 'error'
    const kind = request.body?.kind ?? 'test.synthetic_alert'
    const message = request.body?.message ?? 'F9 smoke test alert'

    const result = await logEventAwaitable({
      kind,
      severity,
      errorMessage: message,
      metadata: {
        source: 'admin_test',
        triggeredBy: request.user?.id ?? null,
      },
    })

    return reply.send({
      event_id: result.eventId,
      alert_attempted: result.alertAttempted,
      alert_throttled: result.alertResult?.skippedReason === 'throttled',
      alert_skipped_reason: result.alertResult?.skippedReason ?? null,
    })
  })
}

export default fp(adminRoutes, {
  name: 'admin-routes',
  fastify: '4.x',
})
