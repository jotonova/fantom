import { eq, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, shortsRenders } from '@fantom/db'
import { logEvent } from '@fantom/observability'
import { requireAuth } from '../plugins/auth.js'

// ── Routes ────────────────────────────────────────────────────────────────────

const shortsRenderRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /shorts-renders/:id/cancel ─────────────────────────────────────────────
  // Sets render status to 'cancelled'. The worker's next cancellation checkpoint
  // will detect this and gracefully abort the job without retrying.
  fastify.post<{ Params: { id: string } }>(
    '/shorts-renders/:id/cancel',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      const render = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx
          .select()
          .from(shortsRenders)
          .where(eq(shortsRenders.id, id))
          .limit(1)
        return row
      })

      if (!render) return reply.code(404).send({ error: 'Render not found' })

      if (render.status !== 'queued' && render.status !== 'running') {
        return reply.code(409).send({
          error: `Cannot cancel a render with status '${render.status}'`,
        })
      }

      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx
          .update(shortsRenders)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(shortsRenders.id, id))
          .returning()
        return row
      })

      logEvent({
        tenantId,
        kind: 'shorts.render.cancel_requested',
        severity: 'info',
        subjectType: 'shorts_render',
        subjectId: id,
        metadata: { briefId: render.briefId, previousStatus: render.status },
      })

      return reply.send(updated)
    },
  )
}

export default fp(shortsRenderRoutes, {
  name: 'shorts-render-routes',
  fastify: '4.x',
})
