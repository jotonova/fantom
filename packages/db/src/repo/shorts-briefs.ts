import { and, desc, eq, lt, sql } from 'drizzle-orm'
import type { Db } from '../client.js'
import { shortsBriefs } from '../schema/index.js'
import type { NewShortsBrief, ShortsBrief } from '../schema/index.js'

// ── Types ──────────────────────────────────────────────────────────────────────

export type CreateShortsBriefParams = Pick<
  NewShortsBrief,
  | 'tenantId'
  | 'title'
  | 'sourceAssetIds'
> &
  Partial<
    Pick<
      NewShortsBrief,
      | 'createdByUserId'
      | 'description'
      | 'brandKitId'
      | 'voiceCloneId'
      | 'durationSeconds'
      | 'opening'
      | 'openingVoiceoverScript'
      | 'closing'
      | 'closingVoiceoverScript'
      | 'pacing'
      | 'mainScenes'
    >
  >

export type UpdateShortsBriefParams = Partial<
  Pick<
    NewShortsBrief,
    | 'title'
    | 'description'
    | 'brandKitId'
    | 'voiceCloneId'
    | 'durationSeconds'
    | 'sourceAssetIds'
    | 'opening'
    | 'openingVoiceoverScript'
    | 'closing'
    | 'closingVoiceoverScript'
    | 'pacing'
    | 'mainScenes'
    | 'status'
    | 'errorMessage'
  >
>

// ── Functions ──────────────────────────────────────────────────────────────────

/** Insert a new brief in 'draft' status. RLS must already be active on `db`. */
export async function createShortsBrief(
  db: Db,
  params: CreateShortsBriefParams,
): Promise<ShortsBrief> {
  const [row] = await db
    .insert(shortsBriefs)
    .values({ ...params, status: 'draft' })
    .returning()
  if (!row) throw new Error('shorts_briefs insert returned no rows')
  return row
}

/** Fetch a single brief by primary key. Returns null when not found. */
export async function getShortsBriefById(
  db: Db,
  id: string,
): Promise<ShortsBrief | null> {
  const [row] = await db
    .select()
    .from(shortsBriefs)
    .where(eq(shortsBriefs.id, id))
    .limit(1)
  return row ?? null
}

/**
 * List briefs for a tenant, newest-first, with keyset pagination.
 * Pass `cursor` as the `id` of the last item in the previous page.
 */
export async function listShortsBriefsByTenant(
  db: Db,
  tenantId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<ShortsBrief[]> {
  const { limit = 50, cursor } = opts

  const conditions = [eq(shortsBriefs.tenantId, tenantId)]

  if (cursor) {
    // Keyset: fetch the cursor row's createdAt, then filter rows older than it.
    const [cursorRow] = await db
      .select({ createdAt: shortsBriefs.createdAt })
      .from(shortsBriefs)
      .where(eq(shortsBriefs.id, cursor))
      .limit(1)
    if (cursorRow) {
      conditions.push(lt(shortsBriefs.createdAt, cursorRow.createdAt))
    }
  }

  return db
    .select()
    .from(shortsBriefs)
    .where(and(...conditions))
    .orderBy(desc(shortsBriefs.createdAt))
    .limit(limit)
}

/**
 * Partial update — only supplied fields are written.
 * `updatedAt` is always refreshed. Returns null when the row is not found.
 */
export async function updateShortsBrief(
  db: Db,
  id: string,
  params: UpdateShortsBriefParams,
): Promise<ShortsBrief | null> {
  if (Object.keys(params).length === 0) return getShortsBriefById(db, id)
  const [row] = await db
    .update(shortsBriefs)
    .set({ ...params, updatedAt: new Date() })
    .where(eq(shortsBriefs.id, id))
    .returning()
  return row ?? null
}

/** Hard-delete a brief. Returns true if a row was deleted. */
export async function deleteShortsBrief(db: Db, id: string): Promise<boolean> {
  const result = await db
    .delete(shortsBriefs)
    .where(eq(shortsBriefs.id, id))
    .returning({ id: shortsBriefs.id })
  return result.length > 0
}
