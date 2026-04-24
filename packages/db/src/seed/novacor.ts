import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db, pool } from '../client.js'
import { tenantUsers, tenants, users } from '../schema/index.js'

// Idempotent seed: safe to run multiple times.
// Uses ON CONFLICT DO NOTHING on unique keys (slug, email, composite PK).

// 1. Tenant
await db
  .insert(tenants)
  .values({ slug: 'novacor', name: 'Novacor Real Estate', status: 'active' })
  .onConflictDoNothing()

// 2. User
await db
  .insert(users)
  .values({ email: 'novacor.icaz@gmail.com', name: 'Justin Casanova' })
  .onConflictDoNothing()

// 3. Resolve IDs (they may already exist from a previous run)
const [tenant] = await db
  .select({ id: tenants.id })
  .from(tenants)
  .where(eq(tenants.slug, 'novacor'))
  .limit(1)

const [user] = await db
  .select({ id: users.id })
  .from(users)
  .where(eq(users.email, 'novacor.icaz@gmail.com'))
  .limit(1)

if (!tenant || !user) {
  throw new Error('Seed failed: could not resolve tenant or user after insert')
}

// 4. Membership
await db
  .insert(tenantUsers)
  .values({ tenantId: tenant.id, userId: user.id, role: 'owner' })
  .onConflictDoNothing()

console.log('✓ Seed complete: Novacor tenant + Justin Casanova (owner) seeded')

await pool.end()
