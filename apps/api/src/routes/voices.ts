import { eq, sql } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db, assets, voiceClones, tenants } from '@fantom/db'
import type { VoiceClone } from '@fantom/db'
import { getPublicUrl, putObject, buildKey } from '@fantom/storage'
import { listVoices, cloneVoice, synthesize, deleteVoice, getVoice } from '@fantom/voice'
import type { VoiceListItem } from '@fantom/voice'
import { requireAuth } from '../plugins/auth.js'

// ── Simple in-memory cache for ElevenLabs defaults ────────────────────────────

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

let elDefaultsCache: CacheEntry<VoiceListItem[]> | null = null

async function getCachedElevenLabsDefaults(): Promise<VoiceListItem[]> {
  const now = Date.now()
  if (elDefaultsCache && elDefaultsCache.expiresAt > now) {
    return elDefaultsCache.data
  }
  const all = await listVoices()
  // "defaults" = voices not cloned by the account (category is 'premade' or 'professional')
  const defaults = all.filter((v) => v.category !== 'cloned')
  elDefaultsCache = { data: defaults, expiresAt: now + 60 * 60 * 1000 }
  return defaults
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type DefaultKind = 'listing_video' | 'market_update' | 'virtual_tour' | 'flip_video' | 'general'
const DEFAULT_KINDS: readonly DefaultKind[] = [
  'listing_video',
  'market_update',
  'virtual_tour',
  'flip_video',
  'general',
]
function isDefaultKind(v: unknown): v is DefaultKind {
  return typeof v === 'string' && (DEFAULT_KINDS as readonly string[]).includes(v)
}

async function getTenantSlug(tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  return row?.slug ?? null
}

// ── Routes ────────────────────────────────────────────────────────────────────

const voiceRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /voices/elevenlabs-defaults ────────────────────────────────────────────
  // Must be registered BEFORE /voices/:id to avoid route collision.
  fastify.get(
    '/voices/elevenlabs-defaults',
    { preHandler: requireAuth },
    async (_request, reply) => {
      const defaults = await getCachedElevenLabsDefaults()
      return reply.send({ voices: defaults })
    },
  )

  // GET /voices ────────────────────────────────────────────────────────────────
  fastify.get('/voices', { preHandler: requireAuth }, async (request, reply) => {
    const tenantId = request.tenantId!

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      return tx
        .select()
        .from(voiceClones)
        .where(eq(voiceClones.tenantId, tenantId))
        .orderBy(voiceClones.createdAt)
    })

    return reply.send({ voices: rows })
  })

  // POST /voices ───────────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      name: string
      description?: string
      sourceAssetId?: string
      defaultForKind?: string
    }
  }>('/voices', { preHandler: requireAuth }, async (request, reply) => {
    const { name, description, sourceAssetId, defaultForKind } = request.body ?? {}

    if (typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({ error: 'name is required' })
    }
    if (defaultForKind !== undefined && !isDefaultKind(defaultForKind)) {
      return reply.code(400).send({ error: 'invalid defaultForKind value' })
    }

    const tenantId = request.tenantId!
    const userId = request.user!.id

    let providerVoiceId: string | null = null
    let status: VoiceClone['status'] = 'pending'
    let resolvedSourceAssetId: string | null = sourceAssetId ?? null

    if (typeof sourceAssetId === 'string' && sourceAssetId) {
      // Download the audio asset from R2 and clone it via ElevenLabs.
      const sourceAsset = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx
          .select()
          .from(assets)
          .where(eq(assets.id, sourceAssetId))
          .limit(1)
        return row
      })

      if (!sourceAsset) return reply.code(404).send({ error: 'Source asset not found' })
      if (sourceAsset.kind !== 'audio') {
        return reply.code(400).send({ error: 'Source asset must be an audio file' })
      }

      // Fetch the audio file from R2 via the public URL.
      const publicUrl = getPublicUrl(sourceAsset.r2Key)
      const audioRes = await fetch(publicUrl)
      if (!audioRes.ok) {
        return reply.code(502).send({ error: 'Failed to fetch audio from storage' })
      }
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer())

      // Clone via ElevenLabs.
      const clone = await cloneVoice({
        name: name.trim(),
        ...(description !== undefined ? { description } : {}),
        audioFileBuffer: audioBuffer,
        filename: sourceAsset.originalFilename,
      })
      providerVoiceId = clone.providerVoiceId
      status = 'ready'
    }

    const voice = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx
        .insert(voiceClones)
        .values({
          tenantId,
          name: name.trim(),
          description: description ?? null,
          provider: 'elevenlabs',
          providerVoiceId,
          isDefaultForKind: isDefaultKind(defaultForKind) ? defaultForKind : null,
          sourceAssetId: resolvedSourceAssetId,
          status,
          createdByUserId: userId,
        })
        .returning()
      return row
    })

    if (!voice) return reply.code(500).send({ error: 'Failed to create voice' })
    return reply.code(201).send(voice)
  })

  // POST /voices/from-elevenlabs/:voiceId ──────────────────────────────────────
  fastify.post<{
    Params: { voiceId: string }
    Body: { name: string; description?: string; defaultForKind?: string }
  }>(
    '/voices/from-elevenlabs/:voiceId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { voiceId } = request.params
      const { name, description, defaultForKind } = request.body ?? {}

      if (typeof name !== 'string' || !name.trim()) {
        return reply.code(400).send({ error: 'name is required' })
      }
      if (defaultForKind !== undefined && !isDefaultKind(defaultForKind)) {
        return reply.code(400).send({ error: 'invalid defaultForKind value' })
      }

      // Verify the voice exists in ElevenLabs.
      try {
        await getVoice(voiceId)
      } catch {
        return reply.code(404).send({ error: 'ElevenLabs voice not found' })
      }

      const tenantId = request.tenantId!
      const userId = request.user!.id

      const voice = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx
          .insert(voiceClones)
          .values({
            tenantId,
            name: name.trim(),
            description: description ?? null,
            provider: 'elevenlabs',
            providerVoiceId: voiceId,
            isDefaultForKind: isDefaultKind(defaultForKind) ? defaultForKind : null,
            sourceAssetId: null,
            status: 'ready',
            createdByUserId: userId,
          })
          .returning()
        return row
      })

      if (!voice) return reply.code(500).send({ error: 'Failed to adopt voice' })
      return reply.code(201).send(voice)
    },
  )

  // POST /voices/:id/synthesize ────────────────────────────────────────────────
  fastify.post<{
    Params: { id: string }
    Body: { text: string }
  }>('/voices/:id/synthesize', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params
    const { text } = request.body ?? {}

    if (typeof text !== 'string' || !text.trim()) {
      return reply.code(400).send({ error: 'text is required' })
    }
    if (text.length > 5000) {
      return reply.code(400).send({ error: 'text must not exceed 5000 characters' })
    }

    const tenantId = request.tenantId!
    const userId = request.user!.id

    // Fetch the voice (tenant-scoped via RLS).
    const voice = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx
        .select()
        .from(voiceClones)
        .where(eq(voiceClones.id, id))
        .limit(1)
      return row
    })

    if (!voice) return reply.code(404).send({ error: 'Voice not found' })
    if (voice.status !== 'ready' || !voice.providerVoiceId) {
      return reply.code(409).send({ error: 'Voice is not ready for synthesis' })
    }

    // Synthesize via ElevenLabs.
    const mp3Buffer = await synthesize({ text: text.trim(), voiceId: voice.providerVoiceId })

    // Upload the MP3 to R2.
    const slug = await getTenantSlug(tenantId)
    if (!slug) return reply.code(404).send({ error: 'Tenant not found' })

    const timestamp = Date.now()
    const filename = `${voice.name.replace(/\s+/g, '-').toLowerCase()}-synthesis-${timestamp}.mp3`
    const key = buildKey(slug, 'audio', filename)
    await putObject(key, mp3Buffer, 'audio/mpeg')

    // Register the asset in the DB.
    const asset = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
      const [row] = await tx
        .insert(assets)
        .values({
          tenantId,
          uploadedByUserId: userId,
          kind: 'audio',
          originalFilename: filename,
          mimeType: 'audio/mpeg',
          sizeBytes: mp3Buffer.length,
          r2Key: key,
          tags: ['synthesis', voice.name],
        })
        .returning()
      return row
    })

    if (!asset) return reply.code(500).send({ error: 'Failed to register synthesized asset' })
    return reply.send({ ...asset, publicUrl: getPublicUrl(asset.r2Key) })
  })

  // DELETE /voices/:id ─────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/voices/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const tenantId = request.tenantId!

      const voice = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        const [row] = await tx
          .select()
          .from(voiceClones)
          .where(eq(voiceClones.id, id))
          .limit(1)
        return row
      })

      if (!voice) return reply.code(404).send({ error: 'Voice not found' })

      // Delete from DB.
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
        await tx.delete(voiceClones).where(eq(voiceClones.id, id))
      })

      // If this was a custom clone (created from a user's audio), delete from ElevenLabs.
      if (voice.sourceAssetId && voice.providerVoiceId && voice.status === 'ready') {
        try {
          await deleteVoice(voice.providerVoiceId)
        } catch (err) {
          fastify.log.error(err, `ElevenLabs deleteVoice failed for ${voice.providerVoiceId}`)
        }
      }

      return reply.code(204).send()
    },
  )
}

export default fp(voiceRoutes, {
  name: 'voice-routes',
  fastify: '4.x',
})
