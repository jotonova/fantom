import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('sessions_user_id_idx').on(table.userId),
    tokenHashIdx: index('sessions_token_hash_idx').on(table.tokenHash),
  }),
)

export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
