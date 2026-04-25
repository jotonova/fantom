import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
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

export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${r2AccountId()}.r2.cloudflarestorage.com`,
  forcePathStyle: false, // virtual-hosted style: <bucket>.<account>.r2.cloudflarestorage.com
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
