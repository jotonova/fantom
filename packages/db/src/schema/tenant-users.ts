import { pgEnum, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './tenants.js'
import { users } from './users.js'

export const tenantUserRoleEnum = pgEnum('tenant_user_role', ['owner', 'editor', 'viewer'])

export const tenantUsers = pgTable(
  'tenant_users',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: tenantUserRoleEnum('role').notNull().default('viewer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.userId] }),
  }),
)

export type TenantUser = typeof tenantUsers.$inferSelect
export type NewTenantUser = typeof tenantUsers.$inferInsert
