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
import { tenants } from './tenants.js'
import { users } from './users.js'
import { assets } from './assets.js'

export const jobKindEnum = pgEnum('job_kind', [
  'render_test_video',
  'render_listing_video',
  'render_market_update',
  'render_virtual_tour',
  'render_flip_video',
  'render_youtube_edit',
])

export const jobStatusEnum = pgEnum('job_status', [
  'pending',
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
])

export type JobKind = (typeof jobKindEnum.enumValues)[number]
export type JobStatus = (typeof jobStatusEnum.enumValues)[number]

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    kind: jobKindEnum('kind').notNull(),
    status: jobStatusEnum('status').notNull().default('pending'),
    progress: integer('progress').notNull().default(0),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    outputAssetId: uuid('output_asset_id').references(() => assets.id, {
      onDelete: 'set null',
    }),
    errorMessage: text('error_message'),
    errorStack: text('error_stack'),
    retries: integer('retries').notNull().default(0),
    maxRetries: integer('max_retries').notNull().default(2),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantStatusCreatedAtIdx: index('jobs_tenant_status_created_at_idx').on(
      table.tenantId,
      table.status,
      table.createdAt,
    ),
    statusCreatedAtIdx: index('jobs_status_created_at_idx').on(table.status, table.createdAt),
  }),
)

export type Job = typeof jobs.$inferSelect
export type NewJob = typeof jobs.$inferInsert
