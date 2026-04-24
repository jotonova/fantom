import 'dotenv/config'
import bcrypt from 'bcrypt'
import { eq } from 'drizzle-orm'
import { db, pool } from '../client.js'
import { tenantUsers, tenants, users } from '../schema/index.js'

// Idempotent seed: safe to run multiple times.
// Uses ON CONFLICT DO NOTHING / DO UPDATE as appropriate.

// Password for both Justin and Amy. See Decision #004 in DECISIONS.md:
// MANDATORY ROTATION: before any external user (non-Justin, non-Amy) is added
// to Fantom, this default password MUST be rotated.
const DEFAULT_PASSWORD = '061284'
const BCRYPT_COST = 12

console.log('Hashing passwords (bcrypt cost 12 — this takes a few seconds)…')
const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, BCRYPT_COST)

// 1. Tenant
await db
  .insert(tenants)
  .values({ slug: 'novacor', name: 'Novacor Real Estate', status: 'active' })
  .onConflictDoNothing()

// 2. Users — insert or update password_hash so re-runs refresh the hash.
await db
  .insert(users)
  .values({ email: 'novacor.icaz@gmail.com', name: 'Justin Casanova', passwordHash })
  .onConflictDoUpdate({
    target: users.email,
    set: { passwordHash, passwordUpdatedAt: new Date() },
  })

await db
  .insert(users)
  .values({ email: 'amy@desert-legacy.com', name: 'Amy Casanova', passwordHash })
  .onConflictDoUpdate({
    target: users.email,
    set: { passwordHash, passwordUpdatedAt: new Date() },
  })

// 3. Resolve IDs
const [tenant] = await db
  .select({ id: tenants.id })
  .from(tenants)
  .where(eq(tenants.slug, 'novacor'))
  .limit(1)

const [justin] = await db
  .select({ id: users.id })
  .from(users)
  .where(eq(users.email, 'novacor.icaz@gmail.com'))
  .limit(1)

const [amy] = await db
  .select({ id: users.id })
  .from(users)
  .where(eq(users.email, 'amy@desert-legacy.com'))
  .limit(1)

if (!tenant || !justin || !amy) {
  throw new Error('Seed failed: could not resolve tenant or users after insert')
}

// 4. Memberships — both users are owners of Novacor
await db
  .insert(tenantUsers)
  .values({ tenantId: tenant.id, userId: justin.id, role: 'owner' })
  .onConflictDoNothing()

await db
  .insert(tenantUsers)
  .values({ tenantId: tenant.id, userId: amy.id, role: 'owner' })
  .onConflictDoNothing()

console.log('✓ Seed complete:')
console.log('  - Novacor Real Estate (tenant)')
console.log('  - Justin Casanova <novacor.icaz@gmail.com> (owner)')
console.log('  - Amy Casanova <amy@desert-legacy.com> (owner)')
console.log('  ⚠  Default password 061284 — rotate before adding external users.')

await pool.end()
