import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, brandKits, assets } from '@fantom/db'
import type { BrandKit } from '@fantom/db'
import { getPublicUrl } from '@fantom/storage'
import { requireAuth } from '../plugins/auth.js'

// ── Asset URL hydration ───────────────────────────────────────────────────────

interface HydratedBrandKit extends BrandKit {
  logoUrl: string | null
  introBumperUrl: string | null
  outroBumperUrl: string | null
}

async function hydrate(kit: BrandKit, tenantId: string): Promise<HydratedBrandKit> {
  const assetIds = [kit.logoAssetId, kit.introBumperAssetId, kit.outroBumperAssetId].filter(
    Boolean,
  ) as string[]

  if (assetIds.length === 0) {
    return { ...kit, logoUrl: null, introBumperUrl: null, outroBumperUrl: null }
  }

  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    return tx
      .select({ id: assets.id, r2Key: assets.r2Key })
      .from(assets)
      .where(
        and(
          eq(assets.tenantId, tenantId),
          inArray(assets.id, assetIds),
        ),
      )
  })

  const urlMap = new Map(rows.map((r) => [r.id, getPublicUrl(r.r2Key)]))

  return {
    ...kit,
    logoUrl: kit.logoAssetId ? (urlMap.get(kit.logoAssetId) ?? null) : null,
    introBumperUrl: kit.introBumperAssetId ? (urlMap.get(kit.introBumperAssetId) ?? null) : null,
    outroBumperUrl: kit.outroBumperAssetId ? (urlMap.get(kit.outroBumperAssetId) ?? null) : null,
  }
}

// ── Brand kit body shape ──────────────────────────────────────────────────────

interface BrandKitBody {
  name?: string
  logoAssetId?: string | null
  primaryColor?: string | null
  secondaryColor?: string | null
  accentColor?: string | null
  headingFont?: string | null
  bodyFont?: string | null
  introBumperAssetId?: string | null
  outroBumperAssetId?: string | null
  captionBgColor?: string | null
  captionTextColor?: string | null
  captionFont?: string | null
  captionPosition?: string | null
  musicVibe?: string | null
}

// ── Routes ────────────────────────────────────────────────────────────────────

const brandKitRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /brand-kits ─────────────────────────────────────────────────────────────
  fastify.get('/brand-kits', { preHandler: requireAuth }, async (request, reply) => {
    const tenantId = request.tenantId!

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      return tx
        .select()
        .from(brandKits)
        .where(eq(brandKits.tenantId, tenantId))
        .orderBy(brandKits.isDefault, brandKits.createdAt)
    })

    const hydrated = await Promise.all(rows.map((k) => hydrate(k, tenantId)))
    return reply.send({ brandKits: hydrated })
  })

  // GET /brand-kits/:id ─────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/brand-kits/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      const [kit] = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx.select().from(brandKits).where(eq(brandKits.id, id)).limit(1)
      })

      if (!kit) return reply.code(404).send({ error: 'Brand kit not found' })
      return reply.send(await hydrate(kit, tenantId))
    },
  )

  // POST /brand-kits ────────────────────────────────────────────────────────────
  fastify.post<{ Body: BrandKitBody }>(
    '/brand-kits',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { name, ...rest } = request.body ?? {}

      if (typeof name !== 'string' || !name.trim()) {
        return reply.code(400).send({ error: 'name is required' })
      }

      const tenantId = request.tenantId!
      const userId = request.user!.id

      const [kit] = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx
          .insert(brandKits)
          .values({
            tenantId,
            name: name.trim(),
            isDefault: false,
            logoAssetId: rest.logoAssetId ?? null,
            primaryColor: rest.primaryColor ?? null,
            secondaryColor: rest.secondaryColor ?? null,
            accentColor: rest.accentColor ?? null,
            headingFont: rest.headingFont ?? null,
            bodyFont: rest.bodyFont ?? null,
            introBumperAssetId: rest.introBumperAssetId ?? null,
            outroBumperAssetId: rest.outroBumperAssetId ?? null,
            captionBgColor: rest.captionBgColor ?? null,
            captionTextColor: rest.captionTextColor ?? null,
            captionFont: rest.captionFont ?? null,
            captionPosition: rest.captionPosition ?? null,
            musicVibe: rest.musicVibe ?? null,
            createdByUserId: userId,
          })
          .returning()
      })

      if (!kit) return reply.code(500).send({ error: 'Failed to create brand kit' })
      return reply.code(201).send(await hydrate(kit, tenantId))
    },
  )

  // PATCH /brand-kits/:id ───────────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string }; Body: BrandKitBody }>(
    '/brand-kits/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      // Build update payload from only the fields provided in the body.
      const body = request.body ?? {}
      const updates: Partial<typeof brandKits.$inferInsert> = {}
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) {
          return reply.code(400).send({ error: 'name must be a non-empty string' })
        }
        updates.name = body.name.trim()
      }
      const nullable: (keyof BrandKitBody)[] = [
        'logoAssetId',
        'primaryColor',
        'secondaryColor',
        'accentColor',
        'headingFont',
        'bodyFont',
        'introBumperAssetId',
        'outroBumperAssetId',
        'captionBgColor',
        'captionTextColor',
        'captionFont',
        'captionPosition',
        'musicVibe',
      ]
      for (const key of nullable) {
        if (key in body) {
          ;(updates as Record<string, unknown>)[key] = body[key] ?? null
        }
      }

      const [kit] = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx
          .update(brandKits)
          .set({ ...updates, updatedAt: new Date() })
          .where(eq(brandKits.id, id))
          .returning()
      })

      if (!kit) return reply.code(404).send({ error: 'Brand kit not found' })
      return reply.send(await hydrate(kit, tenantId))
    },
  )

  // POST /brand-kits/:id/set-default ───────────────────────────────────────────
  // Atomically promotes one kit to default while demoting all others.
  fastify.post<{ Params: { id: string } }>(
    '/brand-kits/:id/set-default',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      const [kit] = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)

        // Verify kit exists and belongs to this tenant.
        const [existing] = await tx
          .select({ id: brandKits.id })
          .from(brandKits)
          .where(eq(brandKits.id, id))
          .limit(1)
        if (!existing) return []

        // Demote all others.
        await tx
          .update(brandKits)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(and(eq(brandKits.tenantId, tenantId), ne(brandKits.id, id)))

        // Promote this one.
        return tx
          .update(brandKits)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(brandKits.id, id))
          .returning()
      })

      if (!kit) return reply.code(404).send({ error: 'Brand kit not found' })
      return reply.send(await hydrate(kit, tenantId))
    },
  )

  // DELETE /brand-kits/:id ──────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/brand-kits/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      const [deleted] = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        return tx.delete(brandKits).where(eq(brandKits.id, id)).returning({ id: brandKits.id })
      })

      if (!deleted) return reply.code(404).send({ error: 'Brand kit not found' })
      return reply.code(204).send()
    },
  )
}

export default fp(brandKitRoutes, {
  name: 'brand-kit-routes',
  fastify: '4.x',
})
