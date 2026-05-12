-- 0030_captions_enabled
-- Adds captions_enabled to shorts_briefs. Defaults to true so all existing
-- briefs burn captions on their next render unless the user opts out.

ALTER TABLE shorts_briefs ADD COLUMN captions_enabled BOOLEAN NOT NULL DEFAULT true;
