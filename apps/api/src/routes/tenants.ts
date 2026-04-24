import { eq, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, tenants } from '@fantom/db'
import { requireAuth } from '../plugins/auth.js'

const tenantRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /tenants/me — returns the active tenant's details for the authenticated user.
  // Requires a valid Bearer token (requireAuth). The tenant is resolved from the
  // JWT payload by the auth plugin, NOT from X-Tenant-Slug (no header bypass).
  fastify.get('/tenants/me', { preHandler: requireAuth }, async (request, reply) => {
    const tenantId = request.tenantId

    if (!tenantId) {
      return reply.code(404).send({ error: 'No tenant resolved' })
    }

    const tenant = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)

      const rows = await tx
        .select({
          id: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          status: tenants.status,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1)

      return rows[0]
    })

    if (!tenant) {
      return reply.code(404).send({ error: 'Tenant not found' })
    }

    return tenant
  })
}

export default fp(tenantRoutes, {
  name: 'tenant-routes',
  fastify: '4.x',
})
