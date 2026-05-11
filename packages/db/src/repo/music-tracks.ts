import { eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { musicTracks } from '../schema/index.js'
import type { MusicTrack } from '../schema/index.js'

/** List all active music tracks ordered by title. */
export async function listMusicTracks(db: Db): Promise<MusicTrack[]> {
  return db.select().from(musicTracks).where(eq(musicTracks.isActive, true)).orderBy(musicTracks.title)
}

/** Fetch a single track by primary key. Returns null when not found. */
export async function getMusicTrackById(db: Db, id: string): Promise<MusicTrack | null> {
  const [row] = await db.select().from(musicTracks).where(eq(musicTracks.id, id)).limit(1)
  return row ?? null
}
