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
  photoCount: number
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
      return 'Calm Walkthrough: slow, deliberate pans that travel the FULL width of the scene — edge to edge. Long, uninterrupted horizontal traversals. Occasional gentle tilt-ups for architectural detail. Every pan must complete its full journey across the frame before ending.'
    case 'excited_reveal':
      return 'Excited Reveal: punchier dynamics, faster pans that sweep the ENTIRE room from one edge to the other. Occasional pull-backs that reveal the full space. Mix horizontal and vertical motion. Open with a strong hook shot that completes a full left-to-right or right-to-left pass.'
    case 'educational_breakdown':
      return 'Educational: stable observational framing, steady pans that cover the FULL width of the scene so the viewer can study every detail. Deliberate, complete traversals — start at one edge, travel to the opposite edge. Minimal flashy motion. No partial pans.'
    default:
      return 'Smooth cinematic camera motion, full edge-to-edge lateral pans, no zooms.'
  }
}

function buildPrompt(input: GenerateShortScriptInput): string {
  const vibeDesc = VIBE_DESCRIPTIONS[input.vibe]
  // 115 wpm: conservative estimate for ElevenLabs pacing (real TTS runs ~10% slower than 130 wpm)
  const approxWords = Math.round((input.targetDurationSeconds / 60) * 115)

  return `You are writing a short-form vertical video voiceover script for a real estate property listing.

The video will be ${input.targetDurationSeconds} seconds long and feature ${input.photoCount} photos in a slideshow format.
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

This video is 9:16 vertical (1080×1920). The source photos are typically landscape orientation. To show the full content of each photo across the vertical frame, your motion hints MUST use FULL TRAVERSAL PANS — camera moves that travel the COMPLETE width of the scene, from one edge to the other. Partial pans and zooms hide content; full edge-to-edge pans reveal it.

Generate one motion hint per photo (count: ${input.photoCount}). Each hint is a camera-centric Runway prompt, 1–2 sentences, instructing the AI to move the camera across the ENTIRE scene.

Vary the motion across the sequence for cinematic rhythm — do not repeat the same direction or technique twice in a row. Use this vibe guidance:

${motionVibeGuidance(input.vibe)}

Each hint should be concrete and camera-centric. Good examples:
  "Camera pans the FULL width of the room from left edge to right edge, smooth continuous tracking shot, cinematic walkthrough feel."
  "Camera performs a complete right-to-left traversal across the kitchen, steady horizontal motion, travels all the way from the right wall to the left wall."
  "Camera tilts upward in a full sweep from floor to ceiling, slow elegant movement revealing the vaulted ceiling."
  "Camera pans the entire backyard in one continuous left-to-right pass, smooth horizontal traversal from fence to fence."

Bad examples (do NOT generate these):
  "Smooth cinematic motion." (too vague — no direction)
  "Pan from left to right." (no indication of full traversal)
  "Zoom in slowly." (loses framing in 9:16)
  "The photo moves." (not camera-centric)
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
