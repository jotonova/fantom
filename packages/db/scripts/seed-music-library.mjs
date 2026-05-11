#!/usr/bin/env node
/**
 * seed-music-library.mjs
 *
 * Uploads Pixabay MP3s to R2 at shared/music-library/{slug}.mp3.
 * Uses the compiled @fantom/storage package (relative path) so no extra deps needed.
 *
 * Usage — run from the repo root:
 *   set -a; source .env.local; set +a
 *   node packages/db/scripts/seed-music-library.mjs ~/Desktop/Pixabay\ Music/
 */

import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Import the compiled storage package via relative path — avoids needing
// @aws-sdk/client-s3 installed locally in packages/db.
const { putObjectFromFile, getObjectMetadata } = await import(
  join(__dirname, '../../storage/dist/index.js')
)

// slug → source filename in Justin's Pixabay Music folder
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
  // Upbeat-Motion.mp3 intentionally excluded — 11s, too short to loop
]

const dir = process.argv[2]
if (!dir) {
  console.error('Usage: node packages/db/scripts/seed-music-library.mjs "/path/to/Pixabay Music/"')
  process.exit(1)
}

const musicDir = resolve(dir)

async function r2KeyExists(r2Key) {
  try {
    await getObjectMetadata(r2Key)
    return true
  } catch {
    return false
  }
}

async function upload({ slug, file }) {
  const localPath = join(musicDir, file)
  const r2Key = `shared/music-library/${slug}.mp3`

  let size
  try {
    size = statSync(localPath).size
  } catch {
    console.error(`  SKIP  ${slug} — file not found: ${localPath}`)
    return false
  }

  if (await r2KeyExists(r2Key)) {
    console.log(`  EXISTS ${r2Key} — skipping`)
    return true
  }

  console.log(`  UPLOAD ${file} → ${r2Key} (${(size / 1024).toFixed(0)} KB)`)
  await putObjectFromFile(r2Key, localPath, 'audio/mpeg')
  console.log(`  OK     ${r2Key}`)
  return true
}

console.log(`Uploading ${TRACK_MAP.length} tracks to R2`)
console.log(`Source:   ${musicDir}`)
console.log()

let ok = 0
let skipped = 0
for (const track of TRACK_MAP) {
  const uploaded = await upload(track)
  if (uploaded) ok++; else skipped++
}

console.log()
console.log(`Done — ${ok} uploaded/already-present, ${skipped} skipped (file not found).`)
