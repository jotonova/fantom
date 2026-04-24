import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './tenants.js'

export const tenantSettings = pgTable(
  'tenant_settings',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.key] }),
  }),
)

export type TenantSetting = typeof tenantSettings.$inferSelect
export type NewTenantSetting = typeof tenantSettings.$inferInsert
