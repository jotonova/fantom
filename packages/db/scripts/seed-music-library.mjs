#!/usr/bin/env node
/**
 * seed-music-library.mjs
 *
 * Uploads local MP3 files to R2 at the paths expected by migration 0028.
 *
 * Usage:
 *   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET_NAME=... \
 *     node packages/db/scripts/seed-music-library.mjs /path/to/music-files/
 *
 * The directory must contain files named exactly:
 *   upbeat-corporate.mp3
 *   summer-vibes.mp3
 *   acoustic-morning.mp3
 *   cinematic-rise.mp3
 *   chill-lofi.mp3
 *   epic-motivation.mp3
 *   soft-piano-bg.mp3
 *   tech-minimal.mp3
 *   upbeat-pop.mp3
 *   ambient-nature.mp3
 *
 * R2 destination: shared/music-library/{slug}.mp3
 */

import { createReadStream, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

const SLUGS = [
  'upbeat-corporate',
  'summer-vibes',
  'acoustic-morning',
  'cinematic-rise',
  'chill-lofi',
  'epic-motivation',
  'soft-piano-bg',
  'tech-minimal',
  'upbeat-pop',
  'ambient-nature',
]

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
} = process.env

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  console.error(
    'Missing R2 env vars. Required: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME',
  )
  process.exit(1)
}

const dir = process.argv[2]
if (!dir) {
  console.error('Usage: node seed-music-library.mjs /path/to/music-files/')
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

async function upload(slug) {
  const localPath = join(musicDir, `${slug}.mp3`)
  const r2Key = `shared/music-library/${slug}.mp3`

  let size
  try {
    size = statSync(localPath).size
  } catch {
    console.error(`  SKIP  ${slug}.mp3 — file not found at ${localPath}`)
    return
  }

  const alreadyUploaded = await fileExists(r2Key)
  if (alreadyUploaded) {
    console.log(`  EXISTS ${r2Key} — skipping`)
    return
  }

  console.log(`  UPLOAD ${slug}.mp3 (${(size / 1024).toFixed(0)} KB) → ${r2Key}`)
  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: r2Key,
      Body: createReadStream(localPath),
      ContentType: 'audio/mpeg',
      ContentLength: size,
    }),
  )
  console.log(`  DONE   ${r2Key}`)
}

console.log(`Uploading music library to R2 bucket: ${R2_BUCKET_NAME}`)
console.log(`Source directory: ${musicDir}`)
console.log()

for (const slug of SLUGS) {
  await upload(slug)
}

console.log()
console.log('Done.')
