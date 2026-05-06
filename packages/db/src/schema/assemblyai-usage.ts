import { index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './tenants.js'
import { assets } from './assets.js'

export const assemblyaiUsage = pgTable(
  'assemblyai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    /** Duration of audio submitted to AssemblyAI in seconds. */
    audioSeconds: numeric('audio_seconds').notNull(),
    /** Estimated USD cost for this transcription. */
    costUsd: numeric('cost_usd').notNull(),
    /** AssemblyAI model used (default: universal-2). */
    model: text('model').notNull().default('universal-2'),
    /** AssemblyAI's transcript ID — stored for debugging and idempotency checks. */
    transcriptionId: text('transcription_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantCreatedAtIdx: index('assemblyai_usage_tenant_created_at_idx').on(
      table.tenantId,
      table.createdAt,
    ),
    createdAtIdx: index('assemblyai_usage_created_at_idx').on(table.createdAt),
  }),
)

export type AssemblyaiUsage = typeof assemblyaiUsage.$inferSelect
export type NewAssemblyaiUsage = typeof assemblyaiUsage.$inferInsert
