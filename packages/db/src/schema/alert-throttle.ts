import { date, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './tenants.js'

export const alertThrottle = pgTable(
  'alert_throttle',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    eventKind: text('event_kind').notNull(),
    lastAlertedAt: timestamp('last_alerted_at', { withTimezone: true }).notNull(),
    alertsSentToday: integer('alerts_sent_today').notNull().default(0),
    dayKey: date('day_key').notNull(),
  },
  (table) => ({
    uniq: unique('alert_throttle_tenant_kind_day').on(
      table.tenantId,
      table.eventKind,
      table.dayKey,
    ),
  }),
)

export type AlertThrottle = typeof alertThrottle.$inferSelect
export type NewAlertThrottle = typeof alertThrottle.$inferInsert
