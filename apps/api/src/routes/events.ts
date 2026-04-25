import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, events } from '@fantom/db'
import { requireAuth } from '../plugins/auth.js'

// ── Routes ────────────────────────────────────────────────────────────────────

const eventsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /events ─────────────────────────────────────────────────────────────────
  // Returns current tenant's events with severity <= 'warn' (no error/critical).
  // Error stacks are never exposed here — those are operator-only via /admin/events/:id.
  fastify.get<{
    Querystring: {
      kind?: string
      kind_prefix?: string
      since?: string
      limit?: string
      cursor?: string
    }
  }>('/events', { preHandler: requireAuth }, async (request, reply) => {
    const tenantId = request.tenantId!
    const { kind, kind_prefix, since, limit: limitStr, cursor } = request.query
    const limit = Math.min(parseInt(limitStr ?? '50', 10) || 50, 200)

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)

      const conditions = [
        eq(events.tenantId, tenantId),
        // Enforce severity <= 'warn' for tenant users (RLS also enforces this,
        // but being explicit at the query level is a useful defense-in-depth layer)
        sql`${events.severity} IN ('debug', 'info', 'warn')`,
      ]

      if (kind) conditions.push(eq(events.kind, kind))
      if (kind_prefix && kind_prefix !== 'all') {
        conditions.push(sql`${events.kind} LIKE ${kind_prefix + '.%'}`)
      }
      if (since) conditions.push(gte(events.createdAt, new Date(since)))
      if (cursor) conditions.push(lt(events.createdAt, new Date(cursor)))

      return tx
        .select({
          id: events.id,
          kind: events.kind,
          severity: events.severity,
          subjectType: events.subjectType,
          subjectId: events.subjectId,
          metadata: events.metadata,
          errorMessage: events.errorMessage,
          // errorStack intentionally omitted — operator-only
          createdAt: events.createdAt,
        })
        .from(events)
        .where(and(...conditions))
        .orderBy(desc(events.createdAt))
        .limit(limit + 1)
    })

    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const nextCursor =
      hasMore && items.length > 0 ? items[items.length - 1]!.createdAt.toISOString() : null

    return reply.send({ events: items, nextCursor })
  })
}

export default fp(eventsRoutes, {
  name: 'events-routes',
  fastify: '4.x',
})
