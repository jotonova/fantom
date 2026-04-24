import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './tenants.js'
import { users } from './users.js'
import { assets } from './assets.js'

export const voiceCloneProviderEnum = pgEnum('voice_clone_provider', [
  'elevenlabs',
  'openai',
  'other',
])

export const voiceCloneDefaultKindEnum = pgEnum('voice_clone_default_kind', [
  'listing_video',
  'market_update',
  'virtual_tour',
  'flip_video',
  'general',
])

export const voiceCloneStatusEnum = pgEnum('voice_clone_status', [
  'pending',
  'processing',
  'ready',
  'failed',
])

export const voiceClones = pgTable(
  'voice_clones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    provider: voiceCloneProviderEnum('provider').notNull().default('elevenlabs'),
    providerVoiceId: text('provider_voice_id'),
    isDefaultForKind: voiceCloneDefaultKindEnum('is_default_for_kind'),
    sourceAssetId: uuid('source_asset_id').references(() => assets.id, {
      onDelete: 'set null',
    }),
    status: voiceCloneStatusEnum('status').notNull().default('pending'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index('voice_clones_tenant_idx').on(table.tenantId),
    tenantDefaultKindIdx: index('voice_clones_tenant_default_kind_idx').on(
      table.tenantId,
      table.isDefaultForKind,
    ),
  }),
)

export type VoiceClone = typeof voiceClones.$inferSelect
export type NewVoiceClone = typeof voiceClones.$inferInsert
