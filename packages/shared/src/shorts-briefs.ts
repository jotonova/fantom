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
