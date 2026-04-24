import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const tenantStatusEnum = pgEnum('tenant_status', ['active', 'suspended', 'archived'])

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').unique().notNull(),
  name: text('name').notNull(),
  status: tenantStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Tenant = typeof tenants.$inferSelect
export type NewTenant = typeof tenants.$inferInsert
