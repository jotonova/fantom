import { VIDEO_UPLOAD_LIMITS } from '@fantom/shared'

// Re-export limits so the upload UI has a single import
export { VIDEO_UPLOAD_LIMITS }

// ── Pricing constants ─────────────────────────────────────────────────────────

/** AssemblyAI Universal-2: $0.37/hr (CheckThat.ai 2026) */
export const ASSEMBLYAI_PER_SECOND_USD = 0.37 / 3600

/** Cloudflare R2 storage: $0.015/GB/month */
export const R2_PER_GB_MONTH_USD = 0.015

// ── Estimate ──────────────────────────────────────────────────────────────────

export interface CostEstimate {
  transcription: number
  storage: number
  total: number
}

/**
 * Estimates the per-clip cost of uploading a video:
 *   - transcription: AssemblyAI cost based on audio duration
 *   - storage: R2 monthly storage cost based on file size
 *
 * @param durationSeconds  Audio duration (full video duration = audio duration for most clips)
 * @param sizeBytes        File size in bytes — known from the browser File object
 */
export function estimateUploadCost(
  durationSeconds: number,
  sizeBytes: number,
): CostEstimate {
  const transcription = durationSeconds * ASSEMBLYAI_PER_SECOND_USD
  const storage = (sizeBytes / (1024 ** 3)) * R2_PER_GB_MONTH_USD
  const total = transcription + storage
  return { transcription, storage, total }
}

/**
 * Formats a cost in USD to a readable string.
 * Sub-cent amounts get more decimal places for clarity.
 */
export function formatCostUsd(usd: number): string {
  if (usd < 0.001) return `$${usd.toFixed(4)}`
  if (usd < 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/**
 * Client-side validation against VIDEO_UPLOAD_LIMITS.
 * Returns an error string if invalid, null if valid.
 */
export function validateVideoFile(
  file: File,
  duration: number,
  width: number,
  height: number,
): string | null {
  if (!(VIDEO_UPLOAD_LIMITS.ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return `Unsupported format: ${file.type || 'unknown'}. Upload MP4, WebM, MOV, AVI, or MPEG.`
  }
  if (file.size > VIDEO_UPLOAD_LIMITS.MAX_SIZE_BYTES) {
    return `File too large: ${(file.size / 1024 / 1024 / 1024).toFixed(2)} GB. Maximum is 20 GB.`
  }
  if (duration > VIDEO_UPLOAD_LIMITS.MAX_DURATION_SECONDS) {
    return `Too long: ${Math.round(duration / 60)} min. Maximum is 120 min.`
  }
  if (Math.min(width, height) < VIDEO_UPLOAD_LIMITS.MIN_DIMENSION) {
    return `Resolution too low: ${width}×${height}. Minimum is 1080p (shorter side ≥ 1080px).`
  }
  return null
}
