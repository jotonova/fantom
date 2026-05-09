import { sql } from 'drizzle-orm'
import { check, index, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { assets } from './assets.js'
import { shortsBriefs } from './shorts-briefs.js'
import { tenants } from './tenants.js'

export const shortsRenders = pgTable(
  'shorts_renders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    briefId: uuid('brief_id').notNull().references(() => shortsBriefs.id, { onDelete: 'cascade' }),
    status: text('status')
      .notNull()
      .default('queued')
      .$type<'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>(),
    bullmqJobId: text('bullmq_job_id'),
    outputAssetId: uuid('output_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    costEstimateUsd: numeric('cost_estimate_usd'),
    costActualUsd: numeric('cost_actual_usd'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    briefIdIdx: index('shorts_renders_brief_id_idx').on(table.briefId),
    tenantStatusIdx: index('shorts_renders_tenant_status_idx').on(table.tenantId, table.status),
    statusCheck: check(
      'shorts_renders_status_check',
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
  }),
)

export type ShortsRender = typeof shortsRenders.$inferSelect
export type NewShortsRender = typeof shortsRenders.$inferInsert
