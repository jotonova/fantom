import type { FastifyRequest, FastifyReply } from 'fastify'
import { requireAuth } from './auth.js'

/**
 * Middleware that requires:
 * 1. A valid JWT (via requireAuth)
 * 2. The authenticated user's role to be 'platform_admin'
 *
 * Platform admin is a cross-tenant role stored in tenant_users.role. It is
 * embedded in the JWT at login time, so no additional DB lookup is needed here.
 */
export async function requirePlatformAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireAuth(request, reply)
  if (reply.sent) return

  if (request.user?.role !== 'platform_admin') {
    return reply.code(403).send({ error: 'Platform admin access required' })
  }
}
