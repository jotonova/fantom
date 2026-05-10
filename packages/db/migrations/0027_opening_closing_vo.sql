-- Migration 0027: opening_voiceover_script + closing_voiceover_script columns
-- These store the spoken text for the opening hook and closing CTA segments,
-- separate from the descriptive opening/closing direction text.

ALTER TABLE shorts_briefs
  ADD COLUMN IF NOT EXISTS opening_voiceover_script text,
  ADD COLUMN IF NOT EXISTS closing_voiceover_script text;
