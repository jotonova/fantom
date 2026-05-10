-- Migration 0026: structured scenes array + drop voiceover_scripts
--
-- main_scenes changes from a free-form JSONB scalar to a typed array:
--   Array<{ id: string, description: string, voiceover_script?: string }>
--
-- Data preservation:
--   Rows where main_scenes is a JSON scalar string  → wrap in array with id='scene-1',
--     absorbing voiceover_scripts into the single scene's voiceover_script field.
--   Rows where main_scenes is already an array       → left untouched.
--   Rows where main_scenes IS NULL                   → left as NULL (no empty-array default).

UPDATE shorts_briefs
SET main_scenes = jsonb_build_array(
  jsonb_build_object(
    'id',               'scene-1',
    'description',      main_scenes #>> '{}',
    'voiceover_script', CASE
                          WHEN voiceover_scripts IS NOT NULL
                            THEN voiceover_scripts #>> '{}'
                          ELSE NULL
                        END
  )
)
WHERE main_scenes IS NOT NULL
  AND jsonb_typeof(main_scenes) != 'array';

ALTER TABLE shorts_briefs DROP COLUMN IF EXISTS voiceover_scripts;
