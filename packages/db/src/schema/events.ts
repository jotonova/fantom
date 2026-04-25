import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './tenants.js'
import { users } from './users.js'

export const eventSeverityEnum = pgEnum('event_severity', [
  'debug',
  'info',
  'warn',
  'error',
  'critical',
])

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    severity: eventSeverityEnum('severity').notNull().default('info'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    subjectType: text('subject_type'),
    subjectId: uuid('subject_id'),
    metadata: jsonb('metadata').notNull().$type<Record<string, unknown>>().default({}),
    errorMessage: text('error_message'),
    errorStack: text('error_stack'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantCreatedAtIdx: index('events_tenant_created_at_idx').on(table.tenantId, table.createdAt),
    severityCreatedAtIdx: index('events_severity_created_at_idx').on(table.severity, table.createdAt),
    kindCreatedAtIdx: index('events_kind_created_at_idx').on(table.kind, table.createdAt),
    subjectIdx: index('events_subject_idx').on(table.subjectType, table.subjectId),
  }),
)

export type Event = typeof events.$inferSelect
export type NewEvent = typeof events.$inferInsert
