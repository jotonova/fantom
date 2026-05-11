-- Migration 0028: music_tracks shared library + shorts_briefs.music_track_id
--
-- music_tracks is NOT tenant-scoped — it is a shared content library.
-- app_user gets SELECT only; INSERT/UPDATE/DELETE are DBA/admin operations.
-- RLS is intentionally omitted (no row-level tenant isolation needed).

CREATE TABLE IF NOT EXISTS "music_tracks" (
  "id"               uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug"             text        NOT NULL UNIQUE,
  "title"            text        NOT NULL,
  "mood"             text,
  "r2_key"           text        NOT NULL,
  "duration_seconds" integer,
  "is_active"        boolean     NOT NULL DEFAULT true,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- app_user can read tracks to populate the picker; no write access.
GRANT SELECT ON "music_tracks" TO "app_user";--> statement-breakpoint

-- Seed: 10 background tracks across five mood categories.
-- Files live at R2 key shared/music-library/{slug}.mp3
-- Upload them with: node packages/db/scripts/seed-music-library.js
INSERT INTO "music_tracks" ("slug", "title", "mood", "r2_key", "duration_seconds") VALUES
  ('upbeat-corporate',   'Upbeat Corporate',        'energetic',  'shared/music-library/upbeat-corporate.mp3',   142),
  ('summer-vibes',       'Summer Vibes',            'upbeat',     'shared/music-library/summer-vibes.mp3',        98),
  ('acoustic-morning',   'Acoustic Morning',        'acoustic',   'shared/music-library/acoustic-morning.mp3',   127),
  ('cinematic-rise',     'Cinematic Rise',          'cinematic',  'shared/music-library/cinematic-rise.mp3',     183),
  ('chill-lofi',         'Chill Lo-Fi',             'chill',      'shared/music-library/chill-lofi.mp3',         134),
  ('epic-motivation',    'Epic Motivation',         'epic',       'shared/music-library/epic-motivation.mp3',    178),
  ('soft-piano-bg',      'Soft Piano Background',   'emotional',  'shared/music-library/soft-piano-bg.mp3',      156),
  ('tech-minimal',       'Tech Minimal',            'corporate',  'shared/music-library/tech-minimal.mp3',       112),
  ('upbeat-pop',         'Upbeat Pop',              'pop',        'shared/music-library/upbeat-pop.mp3',          89),
  ('ambient-nature',     'Ambient Nature',          'ambient',    'shared/music-library/ambient-nature.mp3',     204)
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint

-- Add optional music track FK to shorts_briefs.
-- NULL = no music (render without music layer).
ALTER TABLE "shorts_briefs"
  ADD COLUMN IF NOT EXISTS "music_track_id" uuid
    REFERENCES "music_tracks"("id") ON DELETE SET NULL;
