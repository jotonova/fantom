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

Return a JSON object with EXACTLY these two fields and no other text:
{
  "script": "<the voiceover script, plain text, no stage directions>",
  "suggestedCaptions": ["<caption 1>", "<caption 2>", "<caption 3>", "<caption 4>", "<caption 5>"]
}

Rules:
- script: continuous prose spoken aloud, no formatting, no dashes, no bullet points
- suggestedCaptions: exactly 5 short text overlays (≤12 words each) that could appear on screen during the video; each must stand alone as a punchy phrase
- Return ONLY valid JSON, no markdown fences, no commentary`
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateShortScript(
  input: GenerateShortScriptInput,
): Promise<GenerateShortScriptResult> {
  const client = getClient()

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: buildPrompt(input),
      },
    ],
  })

  // Extract text content from the response
  const textBlock = message.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Anthropic returned no text content')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(textBlock.text.trim())
  } catch {
    throw new Error(`Failed to parse Anthropic response as JSON: ${textBlock.text.slice(0, 200)}`)
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['script'] !== 'string' ||
    !Array.isArray((parsed as Record<string, unknown>)['suggestedCaptions'])
  ) {
    throw new Error('Anthropic response did not match expected schema')
  }

  const result = parsed as { script: string; suggestedCaptions: unknown[] }
  const suggestedCaptions = result.suggestedCaptions
    .slice(0, 5)
    .map((c) => (typeof c === 'string' ? c : String(c)))

  return {
    script: result.script,
    suggestedCaptions,
  }
}
