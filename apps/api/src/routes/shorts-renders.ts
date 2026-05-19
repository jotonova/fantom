import { eq, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, shortsRenders, shortsBriefs } from '@fantom/db'
import { logEvent } from '@fantom/observability'
import { requireAuth } from '../plugins/auth.js'

// ── Routes ────────────────────────────────────────────────────────────────────

const shortsRenderRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /shorts-renders/:id/cancel ─────────────────────────────────────────────
  // Cancels the render: marks the render 'cancelled' AND immediately resets the
  // brief back to 'ready' in the same transaction. Both happen atomically here
  // so the UI reflects the correct state immediately regardless of where the
  // worker is in its pipeline. The worker's cancellation checkpoints will also
  // call patchShortsBrief('ready') when they fire — that's a harmless no-op.
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
        // Reset the brief immediately so the UI shows 'ready' right away.
        // The worker's checkpoint cleanup does the same thing when it fires,
        // but that can be minutes away if ffmpeg is mid-encode.
        await tx
          .update(shortsBriefs)
          .set({ status: 'ready', updatedAt: new Date() })
          .where(eq(shortsBriefs.id, render.briefId))
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
