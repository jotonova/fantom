#!/usr/bin/env node
/**
 * seed-music-library.mjs
 *
 * Uploads Pixabay MP3s to R2 via pre-signed PUT URLs from the prod API.
 * No R2 credentials needed locally — they stay server-side.
 *
 * Prerequisites — add to .env.local (or export before running):
 *   ADMIN_EMAIL=your-admin@email.com
 *   ADMIN_PASSWORD=your-password
 *   FANTOM_API_BASE=https://fantom-api.onrender.com   ← already in .env.local
 *
 * Usage (run from repo root):
 *   set -a; source .env.local; set +a
 *   node packages/db/scripts/seed-music-library.mjs ~/Desktop/Pixabay\ Music/
 */

import { statSync, createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'

// slug → exact filename in Justin's Pixabay Music folder
const TRACK_MAP = [
  { slug: 'upbeat-corporate', file: 'upbeat-corporate.mp3' },
  { slug: 'summer-vibes',     file: 'dance-summer-vibe.mp3' },
  { slug: 'acoustic-upbeat',  file: 'acoustic-upbeat.mp3' },
  { slug: 'upbeat-pop',       file: 'Pop-upbeat.mp3' },
  { slug: 'upbeat-country',   file: 'Upbeat-Country.mp3' },
  { slug: 'chill-lofi',       file: 'Chill.mp3' },
  { slug: 'cinematic-rise',   file: 'cinematic-rise.mp3' },
  { slug: 'epic-motivation',  file: 'Epic motivation.mp3' },
  { slug: 'soft-piano-bg',    file: 'Soft piano.mp3' },
  { slug: 'ambient-nature',   file: 'Ambient-background.mp3' },
  { slug: 'tech-minimal',     file: 'Minimal Tech.mp3' },
]

// ── Env + args ────────────────────────────────────────────────────────────────

const API_BASE = (process.env['FANTOM_API_BASE'] ?? '').replace(/\/$/, '')
const ADMIN_EMAIL = process.env['ADMIN_EMAIL'] ?? ''
const ADMIN_PASSWORD = process.env['ADMIN_PASSWORD'] ?? ''

if (!API_BASE || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error(`
Missing required env vars. Add to .env.local:
  FANTOM_API_BASE=https://fantom-api.onrender.com
  ADMIN_EMAIL=your-admin@email.com
  ADMIN_PASSWORD=your-password

Then run:
  set -a; source .env.local; set +a
  node packages/db/scripts/seed-music-library.mjs ~/Desktop/Pixabay\\ Music/
`)
  process.exit(1)
}

const dir = process.argv[2]
if (!dir) {
  console.error('Usage: node packages/db/scripts/seed-music-library.mjs "/path/to/Pixabay Music/"')
  process.exit(1)
}
const musicDir = resolve(dir)

// ── Step 1: Login to get admin JWT ────────────────────────────────────────────

process.stdout.write('Logging in… ')
const loginRes = await fetch(`${API_BASE}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
})
if (!loginRes.ok) {
  const body = await loginRes.text()
  console.error(`FAILED (${loginRes.status}): ${body}`)
  process.exit(1)
}
const { accessToken } = await loginRes.json()
console.log('OK')

// ── Step 2: Get presigned PUT URLs ────────────────────────────────────────────

process.stdout.write('Fetching presigned upload URLs… ')
const urlRes = await fetch(`${API_BASE}/admin/music-upload-urls`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
  },
  body: JSON.stringify({ slugs: TRACK_MAP.map((t) => t.slug) }),
})
if (!urlRes.ok) {
  const body = await urlRes.text()
  console.error(`FAILED (${urlRes.status}): ${body}`)
  process.exit(1)
}
const { uploads } = await urlRes.json()
console.log(`OK (${uploads.length} URLs, expire in 10 min)`)
console.log()

// Build a slug → url map
const urlMap = Object.fromEntries(uploads.map((u) => [u.slug, u.url]))

// ── Step 3: Upload each file ──────────────────────────────────────────────────

let ok = 0
let skipped = 0
let failed = 0

for (const { slug, file } of TRACK_MAP) {
  const localPath = join(musicDir, file)
  const putUrl = urlMap[slug]

  let size
  try {
    size = statSync(localPath).size
  } catch {
    console.error(`  SKIP  ${slug} — file not found: ${localPath}`)
    skipped++
    continue
  }

  process.stdout.write(`  PUT   ${slug} (${(size / 1024).toFixed(0)} KB)… `)

  // Node 18+ fetch doesn't support ReadableStream from fs.createReadStream directly.
  // Read the file into a Buffer for the PUT body.
  const { readFile } = await import('node:fs/promises')
  const body = await readFile(localPath)

  const putRes = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(size),
    },
    body,
  })

  if (putRes.ok || putRes.status === 200) {
    console.log('OK')
    ok++
  } else {
    const errBody = await putRes.text()
    console.log(`FAILED (${putRes.status}): ${errBody.slice(0, 120)}`)
    failed++
  }
}

console.log()
console.log(`Done — ${ok} uploaded, ${skipped} skipped, ${failed} failed.`)
if (failed > 0) process.exit(1)
