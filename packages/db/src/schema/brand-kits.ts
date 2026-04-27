import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './tenants.js'
import { users } from './users.js'
import { assets } from './assets.js'

export const brandKits = pgTable(
  'brand_kits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug'), // short machine identifier; unique per tenant (partial index, NULL excluded)
    description: text('description'),
    complianceNotes: text('compliance_notes'),
    isDefault: boolean('is_default').notNull().default(false),
    // Logo
    logoAssetId: uuid('logo_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    // Colors (hex strings, e.g. '#1A2B4A')
    primaryColor: text('primary_color'),
    secondaryColor: text('secondary_color'),
    accentColor: text('accent_color'),
    // Fonts
    headingFont: text('heading_font'),
    bodyFont: text('body_font'),
    // Bumpers
    introBumperAssetId: uuid('intro_bumper_asset_id').references(() => assets.id, {
      onDelete: 'set null',
    }),
    outroBumperAssetId: uuid('outro_bumper_asset_id').references(() => assets.id, {
      onDelete: 'set null',
    }),
    // Caption style
    captionBgColor: text('caption_bg_color'),
    captionTextColor: text('caption_text_color'),
    captionFont: text('caption_font'),
    captionPosition: text('caption_position'), // 'top' | 'center' | 'bottom'
    // Music
    musicVibe: text('music_vibe'), // 'upbeat' | 'calm' | 'dramatic' | 'inspirational' | 'none'
    // Audit
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index('brand_kits_tenant_idx').on(table.tenantId),
    tenantDefaultIdx: index('brand_kits_tenant_default_idx').on(table.tenantId, table.isDefault),
  }),
)

export type BrandKit = typeof brandKits.$inferSelect
export type NewBrandKit = typeof brandKits.$inferInsert
