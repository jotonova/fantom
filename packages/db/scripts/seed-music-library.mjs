#!/usr/bin/env node
/**
 * seed-music-library.mjs
 *
 * Uploads Pixabay MP3s from a local directory to R2 at shared/music-library/{slug}.mp3.
 * Uses an explicit slug → source-filename map so Justin doesn't have to rename anything.
 *
 * Usage:
 *   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET_NAME=... \
 *     node packages/db/scripts/seed-music-library.mjs "/path/to/Pixabay Music/"
 *
 * R2 creds are in .env.local — you can source them first:
 *   set -a; source .env.local; set +a
 */

import { createReadStream, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

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

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
} = process.env

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  console.error(
    'Missing R2 env vars.\nRequired: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME\n' +
    'Tip: set -a; source .env.local; set +a',
  )
  process.exit(1)
}

const dir = process.argv[2]
if (!dir) {
  console.error('Usage: node packages/db/scripts/seed-music-library.mjs "/path/to/Pixabay Music/"')
  process.exit(1)
}

const musicDir = resolve(dir)
const client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
})

async function fileExists(r2Key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: r2Key }))
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

  if (await fileExists(r2Key)) {
    console.log(`  EXISTS ${r2Key} — skipping`)
    return true
  }

  console.log(`  UPLOAD ${file} → ${r2Key} (${(size / 1024).toFixed(0)} KB)`)
  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: r2Key,
      Body: createReadStream(localPath),
      ContentType: 'audio/mpeg',
      ContentLength: size,
    }),
  )
  console.log(`  OK     ${r2Key}`)
  return true
}

console.log(`Uploading ${TRACK_MAP.length} tracks to R2 bucket: ${R2_BUCKET_NAME}`)
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
