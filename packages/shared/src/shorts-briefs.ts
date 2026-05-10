import { z } from 'zod'

export const BRIEF_DURATIONS = [15, 30, 45, 60] as const
export const BRIEF_STATUSES = ['draft', 'ready', 'rendering', 'rendered', 'failed'] as const

export type BriefDuration = (typeof BRIEF_DURATIONS)[number]
export type BriefStatus = (typeof BRIEF_STATUSES)[number]

export const BRIEF_PACINGS = ['fast', 'medium', 'slow'] as const
export type BriefPacing = (typeof BRIEF_PACINGS)[number]

// ── Scene ─────────────────────────────────────────────────────────────────────

export const SceneSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).max(2000),
  voiceover_script: z.string().max(5000).optional(),
})

export type Scene = z.infer<typeof SceneSchema>

// ── Request schemas ───────────────────────────────────────────────────────────

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
  mainScenes: z.array(SceneSchema).nullable().optional(),
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
  mainScenes: z.array(SceneSchema).nullable().optional(),
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
  mainScenes: Array<{ id: string; description: string; voiceover_script?: string }> | null
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
  const hasVO = brief.mainScenes?.some((s) => Boolean(s.voiceover_script?.trim())) ?? false
  if (hasVoice && !hasVO) {
    warnings.push('Voice selected but no voiceover scripts in any scene — VO will be skipped.')
  }
  if (hasVO && !hasVoice) {
    warnings.push('Voiceover scripts present in scenes but no voice selected — scripts will be ignored.')
  }

  // Brand kit
  if (!brief.brandKitId) {
    info.push('No brand kit selected — brand overlays will be skipped.')
  }

  // Brief content empty
  const hasContent =
    brief.opening?.trim() ||
    (brief.mainScenes && brief.mainScenes.length > 0) ||
    brief.closing?.trim()
  if (!hasContent) {
    warnings.push('Brief is empty — add an opening, scenes, or closing to guide the AI.')
  }

  return { blockers, warnings, info }
}

// ── Cost estimation ───────────────────────────────────────────────────────────

/** Creator plan rate. TODO: calibrate from actual ElevenLabs bills. */
export const ELEVENLABS_USD_PER_1K_CHARS = 0.30

/**
 * Rough estimate: Render Standard 2GB ≈ $0.0167/hr idle; during active render
 * assume ~2× for CPU headroom → $0.033/hr ÷ 60 min ≈ $0.0006/min wall-clock.
 * Rounded up generously since this is a user-facing display figure, not billing.
 * TODO: calibrate against actual render telemetry.
 */
export const RENDER_USD_PER_MINUTE = 0.02

export interface CostEstimate {
  voCharCount: number
  voCostUsd: number
  renderCostUsd: number
  totalUsd: number
}

/** Pure cost estimation — reused by API (preview endpoint) and UI. */
export function estimateBriefCost(brief: BriefForValidation): CostEstimate {
  // Count chars from all voiceover_script fields in scenes, plus opening/closing
  // (opening and closing are also voiced when a voice is selected)
  const voTexts = [
    brief.opening,
    ...(brief.mainScenes ?? []).map((s) => s.voiceover_script).filter(Boolean),
    brief.closing,
  ].filter(Boolean) as string[]

  const voCharCount = voTexts.join(' ').length
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
