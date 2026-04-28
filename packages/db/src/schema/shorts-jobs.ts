import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { tenants } from './tenants.js'
import { users } from './users.js'
import { assets } from './assets.js'
import { jobs } from './jobs.js'
import { brandKits } from './brand-kits.js'
import { voiceClones } from './voice-clones.js'

export const shortVibeEnum = pgEnum('short_vibe', [
  'excited_reveal',
  'calm_walkthrough',
  'educational_breakdown',
])

export const scriptSourceEnum = pgEnum('script_source', [
  'ai_generated',
  'custom',
])

export const captionSourceEnum = pgEnum('caption_source', [
  'ai_generated',
  'custom',
])

export const shortStatusEnum = pgEnum('short_status', [
  'draft',
  'rendering',
  'rendered',
  'approved',
  'scheduled',
  'posted',
  'failed',
])

export type ShortVibe = (typeof shortVibeEnum.enumValues)[number]
export type ScriptSource = (typeof scriptSourceEnum.enumValues)[number]
export type CaptionSource = (typeof captionSourceEnum.enumValues)[number]
export type ShortStatus = (typeof shortStatusEnum.enumValues)[number]

export const shortsJobs = pgTable(
  'shorts_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    // Brand & Voice
    brandKitId: uuid('brand_kit_id').references(() => brandKits.id, {
      onDelete: 'set null',
    }),
    voiceCloneId: uuid('voice_clone_id').references(() => voiceClones.id, {
      onDelete: 'set null',
    }),
    // Co-brand and compliance brand kits (optional overlays)
    coBrandKitId: uuid('co_brand_kit_id').references(() => brandKits.id, {
      onDelete: 'set null',
    }),
    complianceKitId: uuid('compliance_kit_id').references(() => brandKits.id, {
      onDelete: 'set null',
    }),

    // Input assets (ordered array — images sent to Runway, videos processed locally)
    inputAssetIds: uuid('input_asset_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),

    // Script
    vibe: shortVibeEnum('vibe').notNull().default('calm_walkthrough'),
    scriptSource: scriptSourceEnum('script_source').notNull().default('ai_generated'),
    script: text('script'),

    // Captions
    captionSource: captionSourceEnum('caption_source').notNull().default('ai_generated'),
    captionText: text('caption_text'),

    // Music & SFX
    musicVibe: text('music_vibe'),
    sfxPrompt: text('sfx_prompt'),

    // Motion hints: per-asset hints passed to Runway promptText
    // Shape: Record<assetId, string>
    motionHints: jsonb('motion_hints').$type<Record<string, string>>(),

    // Per-asset render tracking (updated as Runway tasks complete)
    // Shape: Record<assetId, { status: 'pending'|'processing'|'done'|'failed', taskId?: string }>
    assetRenderStatus: jsonb('asset_render_status').$type<
      Record<string, { status: string; taskId?: string }>
    >(),

    // Duration
    targetDurationSeconds: integer('target_duration_seconds').notNull().default(60),

    // Render job linkage
    renderJobId: uuid('render_job_id').references(() => jobs.id, {
      onDelete: 'set null',
    }),

    // Output
    outputAssetId: uuid('output_asset_id').references(() => assets.id, {
      onDelete: 'set null',
    }),

    // Scheduling
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    postedAt: timestamp('posted_at', { withTimezone: true }),

    // Status
    status: shortStatusEnum('status').notNull().default('draft'),
    errorMessage: text('error_message'),

    // Audit
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantStatusIdx: index('shorts_jobs_tenant_status_idx').on(table.tenantId, table.status),
    tenantScheduledIdx: index('shorts_jobs_tenant_scheduled_idx').on(
      table.tenantId,
      table.scheduledFor,
    ),
  }),
)

export type ShortsJob = typeof shortsJobs.$inferSelect
export type NewShortsJob = typeof shortsJobs.$inferInsert
