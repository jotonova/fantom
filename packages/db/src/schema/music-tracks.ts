import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const musicTracks = pgTable('music_tracks', {
  id:              uuid('id').primaryKey().defaultRandom(),
  slug:            text('slug').notNull().unique(),
  title:           text('title').notNull(),
  mood:            text('mood'),
  r2Key:           text('r2_key').notNull(),
  durationSeconds: integer('duration_seconds'),
  isActive:        boolean('is_active').notNull().default(true),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type MusicTrack    = typeof musicTracks.$inferSelect
export type NewMusicTrack = typeof musicTracks.$inferInsert
