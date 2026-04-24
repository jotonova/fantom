import { eq, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import type {} from '@fastify/rate-limit'
import { db } from '@fantom/db'
import { sessions, tenantUsers, tenants, users } from '@fantom/db'
import {
  createAccessToken,
  createRefreshToken,
  hashPassword,
  hashRefreshToken,
  verifyPassword,
} from '../lib/auth.js'
import { requireAuth } from '../plugins/auth.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

// ── Routes ────────────────────────────────────────────────────────────────────

const authRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /auth/login ──────────────────────────────────────────────────────────
  fastify.post<{
    Body: { email: string; password: string }
  }>(
    '/auth/login',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const { email: rawEmail, password } = request.body ?? {}

      if (typeof rawEmail !== 'string' || typeof password !== 'string') {
        return reply.code(400).send({ error: 'email and password are required' })
      }

      if (!EMAIL_RE.test(rawEmail)) {
        return reply.code(400).send({ error: 'Invalid email format' })
      }

      const email = normalizeEmail(rawEmail)

      // Look up user by email (users table has no RLS — safe to query directly).
      const [userRow] = await db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          passwordHash: users.passwordHash,
        })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)

      // Constant-time response: always run verifyPassword even when user not found.
      const DUMMY_HASH =
        '$2b$12$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      const hashToCheck = userRow?.passwordHash ?? DUMMY_HASH
      const passwordOk = await verifyPassword(password, hashToCheck)

      if (!userRow || !userRow.passwordHash || !passwordOk) {
        return reply.code(401).send({ error: 'Invalid credentials' })
      }

      // Resolve tenant memberships.
      // Uses app.current_user_id GUC to satisfy the tenant_users_own_memberships
      // RLS policy (added in migration 0002) — needed once app_user role is active.
      const memberships = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.current_user_id', ${userRow.id}, true)`,
        )

        const rows = await tx
          .select({ tenantId: tenantUsers.tenantId, role: tenantUsers.role })
          .from(tenantUsers)
          .where(eq(tenantUsers.userId, userRow.id))

        if (rows.length === 0) return []

        // Resolve tenant details for each membership within the same transaction.
        const results: Array<{
          tenantId: string
          role: string
          slug: string
          name: string
        }> = []

        for (const m of rows) {
          await tx.execute(
            sql`SELECT set_config('app.current_tenant_id', ${m.tenantId}, true)`,
          )
          const [t] = await tx
            .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
            .from(tenants)
            .where(eq(tenants.id, m.tenantId))
            .limit(1)

          if (t) {
            results.push({ tenantId: m.tenantId, role: m.role, slug: t.slug, name: t.name })
          }
        }

        return results
      })

      if (memberships.length === 0) {
        return reply.code(403).send({ error: 'No tenant access' })
      }

      // Pick first membership (multi-tenant switching is a future concern).
      const membership = memberships[0]!

      // Create tokens.
      const accessToken = createAccessToken(
        (payload, opts) => fastify.jwt.sign(payload, opts),
        userRow.id,
        membership.tenantId,
        membership.role,
      )
      const refreshToken = createRefreshToken()
      const tokenHash = hashRefreshToken(refreshToken)

      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + 30)

      await db.insert(sessions).values({
        userId: userRow.id,
        tokenHash,
        expiresAt,
        userAgent: request.headers['user-agent'] ?? null,
        ipAddress: request.ip,
      })

      return reply.send({
        accessToken,
        refreshToken,
        user: { id: userRow.id, email: userRow.email, name: userRow.name },
        tenant: {
          id: membership.tenantId,
          slug: membership.slug,
          name: membership.name,
          role: membership.role,
        },
      })
    },
  )

  // POST /auth/refresh ─────────────────────────────────────────────────────────
  fastify.post<{ Body: { refreshToken: string } }>(
    '/auth/refresh',
    async (request, reply) => {
      const { refreshToken: rawToken } = request.body ?? {}

      if (typeof rawToken !== 'string' || !rawToken) {
        return reply.code(400).send({ error: 'refreshToken is required' })
      }

      const tokenHash = hashRefreshToken(rawToken)
      const now = new Date()

      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1)

      if (!session || session.expiresAt < now || session.revokedAt !== null) {
        return reply.code(401).send({ error: 'Invalid refresh token' })
      }

      // Look up user + their primary membership for the new token payload.
      const [userRow] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1)

      if (!userRow) {
        return reply.code(401).send({ error: 'Invalid refresh token' })
      }

      const memberships = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.current_user_id', ${userRow.id}, true)`,
        )
        return tx
          .select({ tenantId: tenantUsers.tenantId, role: tenantUsers.role })
          .from(tenantUsers)
          .where(eq(tenantUsers.userId, userRow.id))
      })

      if (memberships.length === 0) {
        return reply.code(403).send({ error: 'No tenant access' })
      }

      const membership = memberships[0]!

      // Rotate: revoke old session, issue new token pair.
      const newRefreshToken = createRefreshToken()
      const newTokenHash = hashRefreshToken(newRefreshToken)
      const newExpiresAt = new Date()
      newExpiresAt.setDate(newExpiresAt.getDate() + 30)

      await db.transaction(async (tx) => {
        await tx
          .update(sessions)
          .set({ revokedAt: now, updatedAt: now })
          .where(eq(sessions.id, session.id))

        await tx.insert(sessions).values({
          userId: userRow.id,
          tokenHash: newTokenHash,
          expiresAt: newExpiresAt,
          userAgent: session.userAgent,
          ipAddress: session.ipAddress,
        })
      })

      const accessToken = createAccessToken(
        (payload, opts) => fastify.jwt.sign(payload, opts),
        userRow.id,
        membership.tenantId,
        membership.role,
      )

      return reply.send({ accessToken, refreshToken: newRefreshToken })
    },
  )

  // POST /auth/logout ──────────────────────────────────────────────────────────
  fastify.post<{ Body: { refreshToken?: string } }>(
    '/auth/logout',
    async (request, reply) => {
      const { refreshToken: rawToken } = request.body ?? {}

      if (typeof rawToken === 'string' && rawToken) {
        const tokenHash = hashRefreshToken(rawToken)
        const now = new Date()
        await db
          .update(sessions)
          .set({ revokedAt: now, updatedAt: now })
          .where(eq(sessions.tokenHash, tokenHash))
      }

      return reply.code(204).send()
    },
  )

  // GET /me ────────────────────────────────────────────────────────────────────
  fastify.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const { id: userId, tenantId, role } = request.user!

    const [userRow] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    if (!userRow) {
      return reply.code(401).send({ error: 'User not found' })
    }

    const tenant = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`,
      )
      const [row] = await tx
        .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1)
      return row
    })

    if (!tenant) {
      return reply.code(404).send({ error: 'Tenant not found' })
    }

    return reply.send({
      user: {
        id: userRow.id,
        email: userRow.email,
        name: userRow.name,
        createdAt: userRow.createdAt,
      },
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, role },
    })
  })

  // GET /auth/debug (dev only) ─────────────────────────────────────────────────
  // Kill this endpoint before F4 begins.
  if (process.env['NODE_ENV'] !== 'production') {
    fastify.get('/auth/debug', async (request) => ({
      user: request.user,
      tenantId: request.tenantId,
    }))
  }
}

export default fp(authRoutes, {
  name: 'auth-routes',
  fastify: '4.x',
})

// Re-export hashPassword for use in seed scripts that need to hash via the same
// bcrypt cost without pulling in the full auth module.
export { hashPassword }
