import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { db } from '@fantom/db'
import { listMusicTracks } from '@fantom/db'
import { getPublicUrl } from '@fantom/storage'
import { requireAuth } from '../plugins/auth.js'

// ── Routes ────────────────────────────────────────────────────────────────────

const musicTrackRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /music-tracks ───────────────────────────────────────────────────────────
  // Returns all active tracks. Used by the brief edit page music picker.
  // Public URL is derived from r2_key so the client can stream a preview.
  fastify.get('/music-tracks', { preHandler: requireAuth }, async (_request, reply) => {
    const tracks = await listMusicTracks(db)
    return reply.send({
      musicTracks: tracks.map((t) => ({
        id: t.id,
        slug: t.slug,
        title: t.title,
        mood: t.mood,
        durationSeconds: t.durationSeconds,
        previewUrl: getPublicUrl(t.r2Key),
      })),
    })
  })
}

export default fp(musicTrackRoutes)
