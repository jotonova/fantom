-- Migration 0029: replace placeholder seed with real Pixabay tracks
--
-- Migration 0028 seeded 10 placeholder rows with approximate durations.
-- This migration updates them to match Justin's actual Pixabay files,
-- removes the placeholder acoustic-morning slug (never referenced by any brief),
-- and inserts two new slugs: acoustic-upbeat and upbeat-country.
--
-- Durations probed with afinfo; r2_keys updated to match real filenames at rest
-- (files uploaded to R2 by seed-music-library.mjs using slug-based names).
-- All 11 tracks upload to: shared/music-library/{slug}.mp3

-- ── Remove the placeholder slug that has no matching file ─────────────────────
DELETE FROM "music_tracks" WHERE "slug" = 'acoustic-morning';--> statement-breakpoint

-- ── Update existing 9 rows with real titles, moods, and durations ─────────────
UPDATE "music_tracks" SET
  "title"            = 'Upbeat Corporate',
  "mood"             = 'upbeat',
  "r2_key"           = 'shared/music-library/upbeat-corporate.mp3',
  "duration_seconds" = 102
WHERE "slug" = 'upbeat-corporate';--> statement-breakpoint

UPDATE "music_tracks" SET
  "title"            = 'Summer Vibes Dance',
  "mood"             = 'upbeat',
  "r2_key"           = 'shared/music-library/summer-vibes.mp3',
  "duration_seconds" = 135
WHERE "slug" = 'summer-vibes';--> statement-breakpoint

UPDATE "music_tracks" SET
  "title"            = 'Upbeat Pop',
  "mood"             = 'upbeat',
  "r2_key"           = 'shared/music-library/upbeat-pop.mp3',
  "duration_seconds" = 119
WHERE "slug" = 'upbeat-pop';--> statement-breakpoint

UPDATE "music_tracks" SET
  "title"            = 'Chill Lofi',
  "mood"             = 'chill',
  "r2_key"           = 'shared/music-library/chill-lofi.mp3',
  "duration_seconds" = 116
WHERE "slug" = 'chill-lofi';--> statement-breakpoint

UPDATE "music_tracks" SET
  "title"            = 'Cinematic Rise',
  "mood"             = 'cinematic',
  "r2_key"           = 'shared/music-library/cinematic-rise.mp3',
  "duration_seconds" = 97
WHERE "slug" = 'cinematic-rise';--> statement-breakpoint

UPDATE "music_tracks" SET
  "title"            = 'Epic Motivation',
  "mood"             = 'cinematic',
  "r2_key"           = 'shared/music-library/epic-motivation.mp3',
  "duration_seconds" = 119
WHERE "slug" = 'epic-motivation';--> statement-breakpoint

UPDATE "music_tracks" SET
  "title"            = 'Soft Piano Background',
  "mood"             = 'ambient',
  "r2_key"           = 'shared/music-library/soft-piano-bg.mp3',
  "duration_seconds" = 75
WHERE "slug" = 'soft-piano-bg';--> statement-breakpoint

UPDATE "music_tracks" SET
  "title"            = 'Ambient Background',
  "mood"             = 'ambient',
  "r2_key"           = 'shared/music-library/ambient-nature.mp3',
  "duration_seconds" = 142
WHERE "slug" = 'ambient-nature';--> statement-breakpoint

UPDATE "music_tracks" SET
  "title"            = 'Minimal Tech',
  "mood"             = 'corporate',
  "r2_key"           = 'shared/music-library/tech-minimal.mp3',
  "duration_seconds" = 140
WHERE "slug" = 'tech-minimal';--> statement-breakpoint

-- ── Insert 2 new tracks ───────────────────────────────────────────────────────
INSERT INTO "music_tracks" ("slug", "title", "mood", "r2_key", "duration_seconds") VALUES
  ('acoustic-upbeat', 'Acoustic Upbeat', 'upbeat', 'shared/music-library/acoustic-upbeat.mp3', 117),
  ('upbeat-country',  'Upbeat Country',  'upbeat', 'shared/music-library/upbeat-country.mp3',  168)
ON CONFLICT ("slug") DO NOTHING;
