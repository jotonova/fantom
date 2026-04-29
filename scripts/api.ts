/**
 * Thin fetch wrapper for the Fantom API.
 *
 * Reads credentials from .fantom-token (written by auth-login.ts).
 * Auto-refreshes the token on 401 by re-running the login flow.
 *
 * Usage (import in other scripts):
 *   import { api } from './api.js'
 *   const result = await api.get('/shorts')
 *   const job    = await api.post('/shorts', { ... })
 *   await api.patch('/shorts/123', { script: '...' })
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { login, TOKEN_FILE } from './auth-login.js'
import type { TokenCache } from './auth-login.js'

// Load .env.local from repo root if present (same logic as auth-login.ts)
const _envLocal = join(process.cwd(), '.env.local')
if (existsSync(_envLocal)) {
  for (const line of readFileSync(_envLocal, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

// ── Token management ──────────────────────────────────────────────────────────

export function readToken(): TokenCache {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as TokenCache
  } catch {
    throw new Error(
      '.fantom-token not found or unreadable. Run: tsx scripts/auth-login.ts',
    )
  }
}

async function refreshToken(): Promise<string> {
  const data = await login()
  return data.accessToken
}

// ── Error type ────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(method: string, path: string, status: number, body: unknown) {
    super(`${method} ${path} → ${status}: ${JSON.stringify(body)}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

// ── Core fetch helper ─────────────────────────────────────────────────────────

async function request(
  method: string,
  path: string,
  body?: unknown,
  _retry = true,
): Promise<unknown> {
  const base = process.env['FANTOM_API_BASE']
  if (!base) throw new Error('FANTOM_API_BASE env var is not set')

  const cache = readToken()
  const url = `${base}${path}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cache.accessToken}`,
  }

  const init: RequestInit = {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }

  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    throw new Error(`Network failure: ${method} ${url} — ${String(err)}`)
  }

  // Auto-refresh on 401, retry once
  if (res.status === 401 && _retry) {
    const fresh = await refreshToken()
    headers['Authorization'] = `Bearer ${fresh}`
    return request(method, path, body, false)
  }

  let responseBody: unknown
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    responseBody = await res.json()
  } else {
    responseBody = await res.text()
  }

  if (!res.ok) {
    throw new ApiError(method, path, res.status, responseBody)
  }

  return responseBody
}

// ── Public API ────────────────────────────────────────────────────────────────

export const api = {
  get:    (path: string)                => request('GET',    path),
  post:   (path: string, body?: unknown) => request('POST',   path, body),
  patch:  (path: string, body?: unknown) => request('PATCH',  path, body),
  delete: (path: string)                => request('DELETE', path),
}
