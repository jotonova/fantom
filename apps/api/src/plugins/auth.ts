import fp from 'fastify-plugin'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'

// Augment @fastify/jwt's FastifyJWT interface to define our user shape.
// This propagates to FastifyRequest.user (which @fastify/jwt declares via conditional type).
declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: { id: string; tenantId: string; role: string } | null
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  // @fastify/jwt may have already decorated request.user — guard against the
  // "decorator already added" crash that fires when both plugins are loaded.
  if (!fastify.hasRequestDecorator('user')) {
    fastify.decorateRequest('user', null)
  }

  fastify.addHook('onRequest', async (request) => {
    const authHeader = request.headers['authorization']
    if (!authHeader?.startsWith('Bearer ')) return

    const token = authHeader.slice(7)
    try {
      const payload = fastify.jwt.verify<{ sub: string; tenantId: string; role: string }>(token)
      request.user = { id: payload.sub, tenantId: payload.tenantId, role: payload.role }
      // Auth token is the trusted source of tenant context — set it here so the
      // tenant-context plugin (which runs next) skips the X-Tenant-Slug lookup.
      request.tenantId = payload.tenantId
    } catch {
      // Invalid or expired token — leave request.user as null. Routes that require
      // auth will reject via requireAuth(); public routes proceed normally.
    }
  })
}

/**
 * Route-level preHandler guard. Apply to any route that requires authentication.
 * Returns 401 when request.user is null (no valid Bearer token was presented).
 *
 * Usage:
 *   fastify.get('/protected', { preHandler: requireAuth }, handler)
 */
export const requireAuth = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  if (!request.user) {
    await reply.code(401).send({ error: 'Authentication required' })
  }
}

export default fp(authPlugin, {
  name: 'auth',
  fastify: '4.x',
  dependencies: ['@fastify/jwt'],
})
