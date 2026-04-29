#!/usr/bin/env tsx
/**
 * Authenticate against the Fantom API and persist the token.
 *
 * Env vars are loaded automatically from .env.local in the repo root (gitignored).
 * You can still override any var inline: FANTOM_API_BASE=... tsx scripts/auth-login.ts
 *
 * On success: writes .fantom-token to the repo root and prints JSON to stdout.
 * On failure: prints an error message to stderr and exits 1.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Load .env.local from repo root if present — simple key=value parser, no dep needed.
const envLocalPath = join(process.cwd(), '.env.local')
if (existsSync(envLocalPath)) {
  for (const line of readFileSync(envLocalPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/)
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2]
    }
  }
}

export interface TokenCache {
  accessToken: string
  refreshToken: string
  user: { id: string; email: string; name: string }
  tenant: { id: string; slug: string; name: string; role: string }
}

export const TOKEN_FILE = join(process.cwd(), '.fantom-token')

export async function login(): Promise<TokenCache> {
  const base = process.env['FANTOM_API_BASE']
  const email = process.env['FANTOM_USER_EMAIL']
  const password = process.env['FANTOM_USER_PASSWORD']

  if (!base || !email || !password) {
    throw new Error(
      'All three env vars are required: FANTOM_API_BASE, FANTOM_USER_EMAIL, FANTOM_USER_PASSWORD',
    )
  }

  let res: Response
  try {
    res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  } catch (err) {
    throw new Error(`Network failure reaching ${base}/auth/login: ${String(err)}`)
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(`Non-JSON response from /auth/login (status ${res.status})`)
  }

  if (res.status === 401) {
    throw new Error(`Invalid credentials (401): ${JSON.stringify(body)}`)
  }
  if (res.status === 403) {
    throw new Error(`No tenant access (403): ${JSON.stringify(body)}`)
  }
  if (!res.ok) {
    throw new Error(`Login failed (${res.status}): ${JSON.stringify(body)}`)
  }

  const data = body as TokenCache
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8')
  return data
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
// Only runs when executed directly (not when imported by api.ts).

if (process.argv[1]?.endsWith('auth-login.ts') || process.argv[1]?.endsWith('auth-login.js')) {
  login()
    .then((data) => {
      console.log(JSON.stringify(data, null, 2))
    })
    .catch((err: unknown) => {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
}
