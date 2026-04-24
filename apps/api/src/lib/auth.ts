import bcrypt from 'bcrypt'
import { createHash, randomBytes } from 'node:crypto'

const BCRYPT_COST = 12

// ── Password hashing ──────────────────────────────────────────────────────────

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST)
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

// ── Access token (JWT) ────────────────────────────────────────────────────────

// SignFn matches the synchronous overload of fastify.jwt.sign — keeps lib/auth.ts
// free from a hard @fastify/jwt import while remaining strictly typed.
type SignFn = (
  payload: Record<string, unknown>,
  options: { expiresIn: string },
) => string

export function createAccessToken(
  sign: SignFn,
  userId: string,
  tenantId: string,
  role: string,
): string {
  return sign({ sub: userId, tenantId, role }, { expiresIn: '15m' })
}

// ── Refresh token ─────────────────────────────────────────────────────────────

/** Returns a cryptographically random opaque string (64 hex chars). */
export function createRefreshToken(): string {
  return randomBytes(32).toString('hex')
}

/** SHA-256 hex digest of a refresh token — store this, never the raw token. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
