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

function buildPrompt(input: GenerateShortScriptInput): string {
  const vibeDesc = VIBE_DESCRIPTIONS[input.vibe]
  const approxWords = Math.round((input.targetDurationSeconds / 60) * 130) // ~130 wpm voiceover

  return `You are writing a short-form vertical video script for a real estate brand called "${input.brandKitName}".

The video will be ${input.targetDurationSeconds} seconds long and feature ${input.photoCount} photos in a slideshow format.
Vibe: ${input.vibe} — ${vibeDesc}
Target word count for the voiceover: approximately ${approxWords} words.
${input.hint ? `Director's hint: ${input.hint}` : ''}

Write a compelling voiceover script and 3–5 short caption suggestions for the video.`
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
          },
          required: ['script', 'suggestedCaptions'],
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

  if (typeof raw['script'] !== 'string' || !Array.isArray(raw['suggestedCaptions'])) {
    throw new Error('emit_script tool input did not match expected schema')
  }

  const suggestedCaptions = (raw['suggestedCaptions'] as unknown[])
    .slice(0, 5)
    .map((c) => (typeof c === 'string' ? c : String(c)))

  return {
    script: raw['script'],
    suggestedCaptions,
  }
}
