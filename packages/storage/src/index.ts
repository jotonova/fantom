import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

function env(key: string): string {
  return process.env[key] ?? ''
}

export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
  },
})

function bucketName(): string {
  return env('R2_BUCKET_NAME')
}

function publicBaseUrl(): string {
  return env('R2_PUBLIC_URL').replace(/\/$/, '')
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
  return `${publicBaseUrl()}/${r2Key}`
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
