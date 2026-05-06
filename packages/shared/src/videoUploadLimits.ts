/**
 * Video upload validation limits — single source of truth.
 * Imported by both apps/api (server validation) and apps/web (client validation)
 * to guarantee the two can never drift apart.
 */
export const VIDEO_UPLOAD_LIMITS = {
  /** 20 GB max per clip */
  MAX_SIZE_BYTES: 20 * 1024 * 1024 * 1024,
  /** 2 hours max duration */
  MAX_DURATION_SECONDS: 120 * 60,
  /**
   * Minimum shorter dimension in pixels.
   * Accepts 1920×1080 landscape AND 1080×1920 portrait. Rejects 1280×720.
   */
  MIN_DIMENSION: 1080,
  ALLOWED_MIME_TYPES: [
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-msvideo',
    'video/mpeg',
  ] as const,
} as const

export type AllowedVideoMimeType = (typeof VIDEO_UPLOAD_LIMITS.ALLOWED_MIME_TYPES)[number]
