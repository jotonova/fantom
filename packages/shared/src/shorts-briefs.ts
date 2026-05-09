import { z } from 'zod'

export const BRIEF_DURATIONS = [15, 30, 45, 60] as const
export const BRIEF_STATUSES = ['draft', 'ready', 'rendering', 'rendered', 'failed'] as const

export type BriefDuration = (typeof BRIEF_DURATIONS)[number]
export type BriefStatus = (typeof BRIEF_STATUSES)[number]

export const BRIEF_PACINGS = ['fast', 'medium', 'slow'] as const
export type BriefPacing = (typeof BRIEF_PACINGS)[number]

export const CreateShortsBriefSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  sourceAssetIds: z.array(z.string().uuid()).min(1, 'At least one source asset is required'),
  brandKitId: z.string().uuid().optional(),
  voiceCloneId: z.string().optional(),
  durationSeconds: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]).default(30),
  opening: z.string().max(2000).optional(),
  closing: z.string().max(2000).optional(),
  pacing: z.enum(BRIEF_PACINGS).optional(),
  mainScenes: z.string().max(10000).nullable().optional(),
  voiceoverScripts: z.string().max(10000).nullable().optional(),
})

export const UpdateShortsBriefSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  sourceAssetIds: z.array(z.string().uuid()).min(1).optional(),
  brandKitId: z.string().uuid().nullable().optional(),
  voiceCloneId: z.string().nullable().optional(),
  durationSeconds: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]).optional(),
  opening: z.string().max(2000).nullable().optional(),
  closing: z.string().max(2000).nullable().optional(),
  pacing: z.enum(BRIEF_PACINGS).nullable().optional(),
  mainScenes: z.string().max(10000).nullable().optional(),
  voiceoverScripts: z.string().max(10000).nullable().optional(),
  status: z.enum(BRIEF_STATUSES).optional(),
  errorMessage: z.string().nullable().optional(),
})

export type CreateShortsBriefInput = z.infer<typeof CreateShortsBriefSchema>
export type UpdateShortsBriefInput = z.infer<typeof UpdateShortsBriefSchema>

// ── Validation ────────────────────────────────────────────────────────────────

export interface BriefForValidation {
  sourceAssetIds: string[]
  voiceCloneId: string | null
  brandKitId: string | null
  opening: string | null
  /** Stored as a string scalar in jsonb; null if unset. */
  mainScenes: string | null
  /** Stored as a string scalar in jsonb; null if unset. */
  voiceoverScripts: string | null
  closing: string | null
  durationSeconds: number
}

export interface ClipForValidation {
  /** node-postgres returns numeric columns as strings; accept both. */
  durationSeconds: string | number | null
}

export interface ValidationResult {
  blockers: string[]
  warnings: string[]
  info: string[]
}

/** Pure validation function — reused by API (preview endpoint) and UI. */
export function validateBriefForReady(
  brief: BriefForValidation,
  clips: ClipForValidation[],
): ValidationResult {
  const blockers: string[] = []
  const warnings: string[] = []
  const info: string[] = []

  // Clips presence (hard blocker)
  if (brief.sourceAssetIds.length === 0 || clips.length === 0) {
    blockers.push('No clips selected — add at least one source clip.')
  }

  // Total clip duration vs target
  if (clips.length > 0) {
    const totalS = clips.reduce((acc, c) => acc + (c.durationSeconds ? Number(c.durationSeconds) : 0), 0)
    const targetS = brief.durationSeconds

    if (totalS > 0 && totalS < targetS) {
      warnings.push(
        `Clips total ${Math.round(totalS)}s is shorter than the ${targetS}s target — output may be padded or fail.`,
      )
    }
    if (totalS > targetS * 2) {
      warnings.push(
        `Clips total ${Math.round(totalS)}s is more than 2× the ${targetS}s target — heavy trimming will occur.`,
      )
    }
  }

  // Voice / script consistency
  const hasVoice = Boolean(brief.voiceCloneId)
  const hasVO = Boolean(brief.voiceoverScripts?.trim())
  if (hasVoice && !hasVO) {
    warnings.push('Voice selected but no voiceover scripts — the AI will generate generic VO.')
  }
  if (hasVO && !hasVoice) {
    warnings.push('Voiceover scripts present but no voice selected — scripts will be ignored.')
  }

  // Brand kit
  if (!brief.brandKitId) {
    info.push('No brand kit selected — brand overlays will be skipped.')
  }

  // Brief content empty
  const hasContent =
    brief.opening?.trim() || brief.mainScenes?.trim() || brief.closing?.trim() || brief.voiceoverScripts?.trim()
  if (!hasContent) {
    warnings.push('Brief is empty — add an opening, main scenes, or closing to guide the AI.')
  }

  return { blockers, warnings, info }
}

// ── Cost estimation ───────────────────────────────────────────────────────────

/** TODO: calibrate from actual ElevenLabs bills in 1B.5. Creator plan rate. */
export const ELEVENLABS_USD_PER_1K_CHARS = 0.30

/** TODO: calibrate from actual render costs in 1B.5. Placeholder. */
export const RENDER_USD_PER_MINUTE = 0.05

export interface CostEstimate {
  voCharCount: number
  voCostUsd: number
  renderCostUsd: number
  totalUsd: number
}

/** Pure cost estimation — reused by API (preview endpoint) and UI. */
export function estimateBriefCost(brief: BriefForValidation): CostEstimate {
  const voText = [brief.opening, brief.mainScenes, brief.voiceoverScripts, brief.closing]
    .filter(Boolean)
    .join(' ')
  const voCharCount = voText.length
  const voCostUsd = (voCharCount / 1000) * ELEVENLABS_USD_PER_1K_CHARS
  const renderMinutes = brief.durationSeconds / 60
  const renderCostUsd = renderMinutes * RENDER_USD_PER_MINUTE
  return {
    voCharCount,
    voCostUsd,
    renderCostUsd,
    totalUsd: voCostUsd + renderCostUsd,
  }
}
