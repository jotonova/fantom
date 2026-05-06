/**
 * One-off script: re-enqueue video_preprocess jobs for assets that
 * are stuck in 'pending' state with no preprocessing results.
 *
 * Run on the Render worker shell (where REDIS_URL + DATABASE_URL are set):
 *   pnpm --filter @fantom/worker tsx scripts/reprocess-stuck.ts
 *
 * Or locally with explicit env vars:
 *   DATABASE_URL=... REDIS_URL=... pnpm --filter @fantom/worker tsx scripts/reprocess-stuck.ts
 */
import 'dotenv/config'
import { db, assets } from '@fantom/db'
import { sql, isNull, and, eq } from 'drizzle-orm'
import { enqueueVideoPreprocess } from '@fantom/jobs'

const PLATFORM_ADMIN_GUC = sql`SELECT set_config('app.is_platform_admin', 'true', true)`

const stuck = await db.transaction(async (tx) => {
  await tx.execute(PLATFORM_ADMIN_GUC)
  return tx
    .select({
      id: assets.id,
      tenantId: assets.tenantId,
      originalFilename: assets.originalFilename,
      transcriptionStatus: assets.transcriptionStatus,
    })
    .from(assets)
    .where(
      and(
        eq(assets.kind, 'video'),
        eq(assets.transcriptionStatus, 'pending'),
        isNull(assets.preprocessedAt),
        // Only assets older than 5 minutes — ignore ones just uploaded
        sql`${assets.createdAt} < NOW() - INTERVAL '5 minutes'`,
      ),
    )
})

if (stuck.length === 0) {
  console.log('No stuck assets found.')
  process.exit(0)
}

console.log(`Found ${stuck.length} stuck asset(s):`)

for (const asset of stuck) {
  console.log(`  ${asset.id}  ${asset.originalFilename}  (${asset.transcriptionStatus})`)
  try {
    await enqueueVideoPreprocess({ assetId: asset.id, tenantId: asset.tenantId })
    console.log(`  ✓ enqueued`)
  } catch (err) {
    console.error(`  ✗ FAILED: ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log('Done.')
process.exit(0)
