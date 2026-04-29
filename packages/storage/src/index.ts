import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

function env(key: string): string {
  return process.env[key] ?? ''
}

// Normalize R2_ACCOUNT_ID to just the 32-char hex regardless of what the user
// pastes in. Cloudflare's dashboard shows the full hostname in several places,
// so it's easy to accidentally copy "abc123.r2.cloudflarestorage.com" instead
// of just "abc123". Strip any protocol prefix and any trailing domain suffix.
function r2AccountId(): string {
  return env('R2_ACCOUNT_ID')
    .replace(/^https?:\/\//, '')
    .replace(/\.r2\.cloudflarestorage\.com\/?$/, '')
    .trim()
}

const _r2Endpoint = `https://${r2AccountId()}.r2.cloudflarestorage.com`
console.log('[fantom-storage] R2 endpoint:', _r2Endpoint, '| bucket:', env('R2_BUCKET_NAME'))

export const r2 = new S3Client({
  region: 'auto',
  endpoint: _r2Endpoint,
  forcePathStyle: true, // path-style: <account>.r2.cloudflarestorage.com/<bucket>/<key>
  // virtual-hosted style was causing TLS handshake failures — the two-level subdomain
  // <bucket>.<account>.r2.cloudflarestorage.com is not covered by *.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
  },
})

function bucketName(): string {
  return env('R2_BUCKET_NAME')
}

function publicBaseUrl(): string {
  return env('R2_PUBLIC_URL')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
}

function sanitizeFilename(filename: string): string {
  return filename
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 100)
}

export function buildKey(tenantSlug: string, kind: string, filename: string): string {
  const now = new Date()
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const id = randomUUID()
  const safe = sanitizeFilename(filename)
  return `${tenantSlug}/${kind}/${yyyy}/${mm}/${id}-${safe}`
}

/**
 * Generates a presigned GET URL for a private R2 object.
 * The URL is accessible to any bearer (e.g. Runway) for `expiresIn` seconds.
 * Defaults to 30 minutes — enough for a Runway processing queue with headroom.
 */
export async function generateDownloadUrl(
  r2Key: string,
  expiresIn = 1800,
): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucketName(), Key: r2Key })
  return getSignedUrl(r2, command, { expiresIn })
}

export async function generateUploadUrl(
  tenantSlug: string,
  kind: string,
  filename: string,
  mimeType: string,
): Promise<{ uploadUrl: string; key: string; expiresAt: Date }> {
  const key = buildKey(tenantSlug, kind, filename)
  const command = new PutObjectCommand({
    Bucket: bucketName(),
    Key: key,
    ContentType: mimeType,
  })
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
  const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 600 })
  return { uploadUrl, key, expiresAt }
}

export function getPublicUrl(r2Key: string): string {
  return `https://${publicBaseUrl()}/${r2Key}`
}

export async function deleteObject(r2Key: string): Promise<void> {
  await r2.send(new DeleteObjectCommand({ Bucket: bucketName(), Key: r2Key }))
}

export interface ObjectMetadata {
  sizeBytes: number
  contentType: string
  lastModified: Date
}

export async function getObjectMetadata(r2Key: string): Promise<ObjectMetadata> {
  const res = await r2.send(new HeadObjectCommand({ Bucket: bucketName(), Key: r2Key }))
  return {
    sizeBytes: res.ContentLength ?? 0,
    contentType: res.ContentType ?? 'application/octet-stream',
    lastModified: res.LastModified ?? new Date(),
  }
}

export async function putObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<void> {
  await r2.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  )
}

// Stream a local file directly to R2 — no Buffer in Node heap.
// ContentLength is required by S3-style APIs when body is a stream.
export async function putObjectFromFile(
  key: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  const { size } = await stat(filePath)
  await r2.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: size,
      ContentType: contentType,
    }),
  )
}

// Stream an R2 object directly to a local file — no Buffer in Node heap.
export async function getObjectToFile(r2Key: string, filePath: string): Promise<void> {
  const res = await r2.send(new GetObjectCommand({ Bucket: bucketName(), Key: r2Key }))
  const src = res.Body as Readable
  const dst = createWriteStream(filePath)
  await new Promise<void>((resolve, reject) => {
    src.on('error', reject)
    dst.on('error', reject)
    dst.on('finish', resolve)
    src.pipe(dst)
  })
}

export async function getObjectBuffer(r2Key: string): Promise<Buffer> {
  const res = await r2.send(new GetObjectCommand({ Bucket: bucketName(), Key: r2Key }))
  const stream = res.Body as Readable
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/** R2 key used as a public-URL health sentinel. Written at worker startup. */
export const R2_HEALTH_SENTINEL_KEY = '_healthcheck/ping.txt'

/**
 * Writes a tiny sentinel object to R2 and returns its public URL.
 * Called once at worker startup so the sentinel always exists and reflects
 * the current deploy. Returns the public URL to poll in the daily health check.
 */
export async function writePublicHealthSentinel(): Promise<string> {
  await putObject(
    R2_HEALTH_SENTINEL_KEY,
    Buffer.from(`fantom-r2-health-ok-${new Date().toISOString()}`),
    'text/plain',
  )
  return getPublicUrl(R2_HEALTH_SENTINEL_KEY)
}

/**
 * Minimal health check: lists up to 1 object to confirm R2 credentials + connectivity.
 * Returns { healthy: true } on success, { healthy: false, error: string } on failure.
 */
export async function checkStorageHealth(): Promise<{ healthy: boolean; error?: string }> {
  try {
    const bucket = bucketName()
    if (!bucket) throw new Error('R2_BUCKET_NAME not configured')
    await r2.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }))
    return { healthy: true }
  } catch (err) {
    return { healthy: false, error: err instanceof Error ? err.message : String(err) }
  }
}
