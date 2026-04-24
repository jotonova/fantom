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

// Endpoints accessible without a tenant identifier.
// Auth routes are system-level (they establish the tenant context, not consume it).
const PUBLIC_PATHS = new Set([
  '/health',
  '/db/health',
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
  '/auth/debug',
])

const tenantContextPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('tenantId', null)

  fastify.addHook('onRequest', async (request, reply) => {
    // If the auth plugin already set tenantId from a valid Bearer token,
    // trust that source and skip the X-Tenant-Slug header lookup entirely.
    if (request.tenantId) return

    const path = request.url.split('?')[0] ?? ''
    if (PUBLIC_PATHS.has(path)) return

    // Resolve tenant slug from header.
    // TODO (F3+): also parse slug from Host subdomain (e.g. novacor.fantomvid.com).
    const slugHeader = request.headers['x-tenant-slug']
    const slug = Array.isArray(slugHeader) ? slugHeader[0] : slugHeader

    if (!slug) {
      return reply.code(401).send({ error: 'X-Tenant-Slug header is required' })
    }

    // System-level lookup: the app DB user runs this as the owner role, which
    // bypasses RLS. This is intentional — we need to resolve the slug before
    // tenant context can be established.
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
