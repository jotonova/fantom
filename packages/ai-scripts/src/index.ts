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
      return 'Calm Walkthrough: slow, deliberate pans and dollies. Long horizontal traversals. Occasional gentle tilt-ups for architectural detail. Avoid quick reveals.'
    case 'excited_reveal':
      return 'Excited Reveal: punchier dynamics, faster pans, occasional pull-backs that reveal full rooms. Mix horizontal and vertical motion. Open with a strong hook shot.'
    case 'educational_breakdown':
      return 'Educational: stable observational framing, steady pans that allow the viewer to study details. Minimal flashy motion. Clear, deliberate camera moves.'
    default:
      return 'Smooth cinematic camera motion, primarily lateral pans, no zooms.'
  }
}

function buildPrompt(input: GenerateShortScriptInput): string {
  const vibeDesc = VIBE_DESCRIPTIONS[input.vibe]
  const approxWords = Math.round((input.targetDurationSeconds / 60) * 130) // ~130 wpm voiceover

  return `You are writing a short-form vertical video script for a real estate brand called "${input.brandKitName}".

The video will be ${input.targetDurationSeconds} seconds long and feature ${input.photoCount} photos in a slideshow format.
Vibe: ${input.vibe} — ${vibeDesc}
Target word count for the voiceover: approximately ${approxWords} words.
${input.hint ? `Director's hint: ${input.hint}` : ''}

Write a compelling voiceover script and 3–5 short caption suggestions for the video.

---
MOTION DIRECTION

This video is 9:16 vertical (1080×1920). The source photos are typically landscape orientation. To show the full content of each photo across the vertical frame, your motion hints MUST favor PANS and LATERAL CAMERA MOVES over zooms. Zooms hide content; pans reveal it.

Generate one motion hint per photo (count: ${input.photoCount}). Each hint is a camera-centric Runway prompt, 1–2 sentences, instructing the AI to move the camera across the scene.

Vary the motion across the sequence for cinematic rhythm — do not repeat the same direction or technique twice in a row. Use this vibe guidance:

${motionVibeGuidance(input.vibe)}

Each hint should be concrete and camera-centric. Good examples:
  "Camera slowly pans from left to right across the room, smooth tracking shot, cinematic walkthrough feel."
  "Slow dolly forward into the kitchen, steady horizontal motion, no zoom or tilt."
  "Camera tilts upward revealing the vaulted ceiling, slow elegant movement."
  "Pan right to left across the backyard, smooth horizontal traversal."

Bad examples (do NOT generate these):
  "Smooth cinematic motion." (too vague)
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
