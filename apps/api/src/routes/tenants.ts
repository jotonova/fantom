import { eq, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, tenants } from '@fantom/db'

const tenantRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/tenants/me', async (request, reply) => {
    let tenantId = request.tenantId

    // Dev-only: accept ?slug=<slug> as a convenience override so you can test
    // with curl without sending the X-Tenant-Slug header.
    if (!tenantId && process.env['NODE_ENV'] !== 'production') {
      const query = request.query as Record<string, unknown>
      const slugParam = query['slug']
      if (typeof slugParam === 'string' && slugParam) {
        const rows = await db
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.slug, slugParam))
          .limit(1)
        tenantId = rows[0]?.id ?? null
      }
    }

    if (!tenantId) {
      return reply.code(404).send({ error: 'No tenant resolved' })
    }

    // Run inside a transaction so SET LOCAL is scoped to this request.
    // set_config(name, value, is_local=true) is the parameterised equivalent
    // of SET LOCAL — safe against SQL injection and transactionally scoped.
    const resolvedId = tenantId
    const tenant = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${resolvedId}, true)`)

      const rows = await tx
        .select({
          id: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          status: tenants.status,
        })
        .from(tenants)
        .where(eq(tenants.id, resolvedId))
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
