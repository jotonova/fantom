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
import { jobs } from './jobs.js'
import { assets } from './assets.js'

export const destinationKindEnum = pgEnum('destination_kind', [
  'webhook',
  'youtube',
  'facebook',
  'instagram',
  'mls',
])

export const distributionStatusEnum = pgEnum('distribution_status', [
  'pending',
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
])

export type DestinationKind = (typeof destinationKindEnum.enumValues)[number]
export type DistributionStatus = (typeof distributionStatusEnum.enumValues)[number]

export const distributions = pgTable(
  'distributions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    destinationKind: destinationKindEnum('destination_kind').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    status: distributionStatusEnum('status').notNull().default('pending'),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    responsePayload: jsonb('response_payload').$type<Record<string, unknown>>(),
    errorMessage: text('error_message'),
    errorStack: text('error_stack'),
    retries: integer('retries').notNull().default(0),
    maxRetries: integer('max_retries').notNull().default(3),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantStatusCreatedAtIdx: index('distributions_tenant_status_created_at_idx').on(
      table.tenantId,
      table.status,
      table.createdAt,
    ),
    jobIdx: index('distributions_job_idx').on(table.jobId),
    statusCreatedAtIdx: index('distributions_status_created_at_idx').on(
      table.status,
      table.createdAt,
    ),
  }),
)

export type Distribution = typeof distributions.$inferSelect
export type NewDistribution = typeof distributions.$inferInsert
