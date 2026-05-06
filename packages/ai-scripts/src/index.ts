import Anthropic from '@anthropic-ai/sdk'

// Lazy singleton so the client is not created until first use
// (avoids crashing at import time if ANTHROPIC_API_KEY is not set in dev).
let _client: Anthropic | null = null

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env['ANTHROPIC_API_KEY']
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
    _client = new Anthropic({ apiKey })
  }
  return _client
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ShortVibe = 'excited_reveal' | 'calm_walkthrough' | 'educational_breakdown'

export interface GenerateShortScriptInput {
  vibe: ShortVibe
  brandKitName: string
  assetCount: number
  targetDurationSeconds: number
  hint?: string
}

export interface GenerateShortScriptResult {
  script: string
  suggestedCaptions: string[]
  motionHints: string[]
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

const VIBE_DESCRIPTIONS: Record<ShortVibe, string> = {
  excited_reveal:
    'high-energy, punchy, exciting — use short sentences, exclamation points, hook immediately',
  calm_walkthrough:
    'calm, measured, conversational — walk the viewer through naturally and build trust',
  educational_breakdown:
    'educational, clear, authoritative — explain with clarity, use simple language, teach something valuable',
}

function motionVibeGuidance(vibe: ShortVibe): string {
  switch (vibe) {
    case 'calm_walkthrough':
      return 'Calm Walkthrough: slow, steady pans across each scene. Mix horizontal pans with occasional forward dolly into rooms. Use vertical tilts sparingly to highlight architectural detail.'
    case 'excited_reveal':
      return 'Excited Reveal: faster pans with clear directional intent. Open with a wide pull-back establishing shot if possible. Vary pan directions between clips. Use forward dolly for impact moments.'
    case 'educational_breakdown':
      return 'Educational: deliberate observational pans that let the viewer study the scene. Steady horizontal motion. Avoid quick or flashy moves — clarity over drama.'
    default:
      return 'Smooth steady pans across the full scene, primarily horizontal direction.'
  }
}

function buildPrompt(input: GenerateShortScriptInput): string {
  const vibeDesc = VIBE_DESCRIPTIONS[input.vibe]
  // 115 wpm: conservative estimate for ElevenLabs pacing (real TTS runs ~10% slower than 130 wpm)
  const approxWords = Math.round((input.targetDurationSeconds / 60) * 115)

  return `You are writing a short-form vertical video voiceover script for a real estate property listing.

The video will be ${input.targetDurationSeconds} seconds long and feature ${input.assetCount} assets in a slideshow format.
Vibe: ${input.vibe} — ${vibeDesc}
STRICT word count limit: ${approxWords} words maximum. Stay UNDER this number. The voiceover MUST fit within ${input.targetDurationSeconds} seconds. Fewer words is fine — more is unacceptable.
Brand tone reference (do NOT name this brand in the script): ${input.brandKitName}
${input.hint ? `Director's hint: ${input.hint}` : ''}

IMPORTANT — DO NOT NAME THE BRAND:
The voiceover must never mention the brand name, agency name, or any company name.
Never open with "Welcome to [Brand]" or "This is [Brand]" or any variation.
The brand logo is already visible on screen — the voiceover speaks to the property, not the company.
Write as if the property itself is speaking, or as a confident, unnamed narrator describing the home.

Write a compelling voiceover script and 3–5 short caption suggestions for the video.

---
MOTION DIRECTION

This video is 9:16 vertical (1080×1920). The source photos are landscape orientation. Pans reveal more of each photo than zooms — favor pans.

Generate one motion hint per asset (count: ${input.assetCount}). Each hint is a Runway image_to_video promptText, 1–2 sentences.

Frame each prompt as a concrete physical instruction with a duration. Each clip is 5 seconds. Use this template:
  "Pan the camera [direction] across the entire scene over 5 seconds, smooth and steady, [specific visual element being revealed]."

Vary the motion across the sequence for cinematic rhythm — alternate directions, occasionally use forward dolly or vertical tilt. Use this vibe guidance:

${motionVibeGuidance(input.vibe)}

Concrete examples (good — physical, time-bounded, scene-anchored):
  "Pan the camera left to right across the entire room over 5 seconds, smooth steady motion, revealing the kitchen island and beyond."
  "Pan the camera right to left across the full width of the backyard over 5 seconds, slow and deliberate."
  "Push the camera forward into the living room over 5 seconds, smooth dolly motion, revealing depth from foreground to background."
  "Tilt the camera upward across the full height of the room over 5 seconds, slow and steady, revealing the ceiling."

Avoid these patterns (too vague or too aggressive — both fail):
  "Subtle motion." (too small)
  "Smooth cinematic motion." (vague)
  "Aggressive sweeping pan." (model retreats to safe motion when prompted with intensity words)
  "Maximum traversal." (intensity language causes regression)
  "Extreme pan." (same)
  "Camera moves." (no direction, no scene anchor)
---`
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateShortScript(
  input: GenerateShortScriptInput,
): Promise<GenerateShortScriptResult> {
  const client = getClient()

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    tools: [
      {
        name: 'emit_script',
        description: 'Emit the generated short-form script and captions',
        input_schema: {
          type: 'object',
          properties: {
            script: {
              type: 'string',
              description: 'The voiceover script text — continuous prose spoken aloud, no stage directions, no formatting',
            },
            suggestedCaptions: {
              type: 'array',
              items: { type: 'string' },
              description: '3–5 short text overlays (≤12 words each) that could appear on screen; each must stand alone as a punchy phrase',
            },
            motionHints: {
              type: 'array',
              items: { type: 'string' },
              description: 'Camera motion direction for each photo, one entry per photo, in order. Each hint is a Runway image_to_video promptText (1–2 sentences). Must contain exactly as many entries as there are photos.',
            },
          },
          required: ['script', 'suggestedCaptions', 'motionHints'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'emit_script' },
    messages: [{ role: 'user', content: buildPrompt(input) }],
  })

  const toolUseBlock = response.content.find((b) => b.type === 'tool_use')
  if (!toolUseBlock || toolUseBlock.type !== 'tool_use' || toolUseBlock.name !== 'emit_script') {
    throw new Error('Model did not return emit_script tool call')
  }

  const raw = toolUseBlock.input as Record<string, unknown>

  if (
    typeof raw['script'] !== 'string' ||
    !Array.isArray(raw['suggestedCaptions']) ||
    !Array.isArray(raw['motionHints'])
  ) {
    throw new Error('emit_script tool input did not match expected schema')
  }

  const suggestedCaptions = (raw['suggestedCaptions'] as unknown[])
    .slice(0, 5)
    .map((c) => (typeof c === 'string' ? c : String(c)))

  const motionHints = (raw['motionHints'] as unknown[])
    .map((h) => (typeof h === 'string' ? h : String(h)))

  return {
    script: raw['script'],
    suggestedCaptions,
    motionHints,
  }
}
