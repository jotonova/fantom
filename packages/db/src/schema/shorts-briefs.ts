import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { brandKits } from './brand-kits.js'
import { musicTracks } from './music-tracks.js'
import { tenants } from './tenants.js'
import { users } from './users.js'

export const shortsBriefs = pgTable(
  'shorts_briefs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    // Input assets (ordered array of source asset UUIDs)
    sourceAssetIds: uuid('source_asset_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),

    // Brief metadata
    title: text('title').notNull(),
    description: text('description'),

    // Voice, Brand & Music
    brandKitId: uuid('brand_kit_id').references(() => brandKits.id, {
      onDelete: 'set null',
    }),
    voiceCloneId: text('voice_clone_id'), // ElevenLabs voice ID — not a FK
    musicTrackId: uuid('music_track_id').references(() => musicTracks.id, {
      onDelete: 'set null',
    }),

    // Duration (15 | 30 | 45 | 60)
    durationSeconds: integer('duration_seconds').notNull().default(30),

    // Creative brief content (nullable — user-written, AI-refined in later phases)
    opening: text('opening'),
    openingVoiceoverScript: text('opening_voiceover_script'), // spoken VO for the opening hook
    closing: text('closing'),
    closingVoiceoverScript: text('closing_voiceover_script'), // spoken VO for the closing CTA
    pacing: text('pacing').$type<'fast' | 'medium' | 'slow'>(),
    density: text('density').$type<'low' | 'medium' | 'high'>().default('medium'),

    // Scene list — each scene has a description and optional voiceover script.
    // Shape: Array<{ id: string, description: string, voiceover_script?: string }> | null
    mainScenes: jsonb('main_scenes').$type<Array<{
      id: string
      description: string
      voiceover_script?: string
    }>>(),

    // Output options
    captionsEnabled: boolean('captions_enabled').notNull().default(true),

    // Status
    status: text('status')
      .notNull()
      .default('draft')
      .$type<'draft' | 'ready' | 'rendering' | 'rendered' | 'failed'>(),
    errorMessage: text('error_message'),

    // Audit
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantStatusIdx: index('shorts_briefs_tenant_status_idx').on(table.tenantId, table.status),
    tenantCreatedAtIdx: index('shorts_briefs_tenant_created_at_idx').on(
      table.tenantId,
      table.createdAt,
    ),
    durationCheck: check(
      'shorts_briefs_duration_check',
      sql`${table.durationSeconds} IN (15, 30, 45, 60)`,
    ),
    statusCheck: check(
      'shorts_briefs_status_check',
      sql`${table.status} IN ('draft', 'ready', 'rendering', 'rendered', 'failed')`,
    ),
    pacingCheck: check(
      'shorts_briefs_pacing_check',
      sql`${table.pacing} IN ('fast', 'medium', 'slow')`,
    ),
    densityCheck: check(
      'shorts_briefs_density_check',
      sql`${table.density} IN ('low', 'medium', 'high')`,
    ),
  }),
)

export type ShortsBrief = typeof shortsBriefs.$inferSelect
export type NewShortsBrief = typeof shortsBriefs.$inferInsert
