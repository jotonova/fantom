import { index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './tenants.js'

export const alertDedupe = pgTable(
  'alert_dedupe',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dedupeKey: text('dedupe_key').notNull(),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull(),
    suppressedCount: integer('suppressed_count').notNull().default(0),
    prevSuppressedCount: integer('prev_suppressed_count').notNull().default(0),
  },
  (table) => ({
    uniq: unique('alert_dedupe_tenant_key').on(table.tenantId, table.dedupeKey),
    lastSentAtIdx: index('alert_dedupe_last_sent_at_idx').on(table.lastSentAt),
  }),
)

export type AlertDedupe = typeof alertDedupe.$inferSelect
export type NewAlertDedupe = typeof alertDedupe.$inferInsert
