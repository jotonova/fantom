import { eq } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, tenants } from '@fantom/db'

// Extend Fastify's request type so all route handlers have access to tenantId.
declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string | null
  }
}

// Endpoints that are accessible without a tenant identifier.
const PUBLIC_PATHS = new Set(['/health', '/db/health'])

const tenantContextPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('tenantId', null)

  fastify.addHook('onRequest', async (request, reply) => {
    // Resolve tenant slug: prefer X-Tenant-Slug header.
    // TODO (F3+): also parse slug from the Host subdomain (e.g. novacor.fantomvid.com).
    const slugHeader = request.headers['x-tenant-slug']
    const slug = Array.isArray(slugHeader) ? slugHeader[0] : slugHeader

    if (!slug) {
      // No tenant identifier — allow only public endpoints.
      const path = request.url.split('?')[0] ?? ''
      if (!PUBLIC_PATHS.has(path)) {
        return reply.code(401).send({ error: 'X-Tenant-Slug header is required' })
      }
      return
    }

    // Look up the tenant by slug. The app DB user (owner) bypasses RLS for this
    // system-level lookup. Once we have the ID, per-query RLS applies via
    // set_config('app.current_tenant_id', ...) inside route-handler transactions.
    const rows = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1)

    const tenant = rows[0]

    if (!tenant) {
      return reply.code(404).send({ error: `Tenant '${slug}' not found` })
    }

    request.tenantId = tenant.id
  })
}

export default fp(tenantContextPlugin, {
  name: 'tenant-context',
  fastify: '4.x',
})
