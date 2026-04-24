import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenants } from './tenants.js'
import { users } from './users.js'

export const assetKindEnum = pgEnum('asset_kind', [
  'image',
  'audio',
  'video',
  'document',
  'other',
])

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    kind: assetKindEnum('kind').notNull(),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    r2Key: text('r2_key').unique().notNull(),
    width: integer('width'),
    height: integer('height'),
    durationSeconds: numeric('duration_seconds'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    tags: text('tags').array().default([]).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantKindIdx: index('assets_tenant_kind_idx').on(table.tenantId, table.kind),
    tenantCreatedAtIdx: index('assets_tenant_created_at_idx').on(
      table.tenantId,
      table.createdAt,
    ),
  }),
)

export type Asset = typeof assets.$inferSelect
export type NewAsset = typeof assets.$inferInsert
