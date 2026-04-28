import { integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './tenants.js'
import { shortsJobs } from './shorts-jobs.js'

export const runwayUsage = pgTable('runway_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  shortsJobId: uuid('shorts_job_id').references(() => shortsJobs.id, { onDelete: 'set null' }),
  /** The input asset ID (asset table UUID or source URL) that was animated */
  assetId: text('asset_id').notNull(),
  /** The Runway task ID returned by the API */
  taskId: text('task_id').notNull(),
  creditsUsed: integer('credits_used').notNull(),
  /** USD cost, e.g. 0.5000 for a 5s clip */
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }).notNull(),
  billedAt: timestamp('billed_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type RunwayUsage = typeof runwayUsage.$inferSelect
export type NewRunwayUsage = typeof runwayUsage.$inferInsert
