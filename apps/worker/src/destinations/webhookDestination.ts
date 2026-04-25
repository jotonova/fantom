import { randomUUID } from 'node:crypto'
import type { DestinationProvider, DistributionContext, DistributionResult } from '@fantom/distribution-bus'
import type { DestinationKind } from '@fantom/distribution-bus'

// ── Webhook config type ───────────────────────────────────────────────────────

interface WebhookConfig {
  url: string
  method?: 'POST' | 'PUT' | 'PATCH'
  headers?: Record<string, string>
  includeAssetMetadata?: boolean
  customPayload?: Record<string, unknown>
}

// ── RetryableError ────────────────────────────────────────────────────────────
// Thrown on 5xx and network failures — the dispatcher will retry.
// NOT thrown on 4xx — client misconfiguration won't self-heal.

export class WebhookRetryableError extends Error {
  readonly statusCode: number | null

  constructor(message: string, statusCode: number | null = null) {
    super(message)
    this.name = 'WebhookRetryableError'
    this.statusCode = statusCode
  }
}

// ── Max response body size to store (64 KB) ───────────────────────────────────
const MAX_RESPONSE_BYTES = 64 * 1024

// ── WebhookDestination ────────────────────────────────────────────────────────

export class WebhookDestination implements DestinationProvider {
  readonly name = 'webhook'

  canHandle(kind: DestinationKind): boolean {
    return kind === 'webhook'
  }

  async publish(context: DistributionContext): Promise<DistributionResult> {
    const { distributionId, tenantId, jobId, asset, config, log } = context

    const cfg = config as unknown as WebhookConfig

    // ── Validate config ───────────────────────────────────────────────────────

    if (!cfg.url || typeof cfg.url !== 'string') {
      throw new Error('Webhook config missing required field: url')
    }

    // HTTPS only — reject http:// to prevent plain-text credential leakage
    if (!cfg.url.startsWith('https://')) {
      throw new Error(`Webhook URL must use HTTPS. Got: ${cfg.url.slice(0, 40)}`)
    }

    const method = cfg.method ?? 'POST'
    const includeAsset = cfg.includeAssetMetadata !== false // default true

    // ── Build payload ─────────────────────────────────────────────────────────

    const assetPayload = includeAsset
      ? {
          publicUrl: asset.publicUrl,
          width: asset.width,
          height: asset.height,
          durationSeconds: asset.durationSeconds,
          sizeBytes: asset.sizeBytes,
          mimeType: asset.mimeType,
          originalFilename: asset.originalFilename,
        }
      : undefined

    const payload: Record<string, unknown> = {
      ...(cfg.customPayload ?? {}),
      event: 'job.completed',
      tenantId,
      jobId,
      ...(assetPayload ? { asset: assetPayload } : {}),
    }

    // ── Build headers ─────────────────────────────────────────────────────────

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Fantom-Webhook/1.0',
      'X-Fantom-Distribution-Id': distributionId,
      ...(cfg.headers ?? {}),
    }

    log('sending webhook', { url: cfg.url, method })

    // ── Send with 30s timeout ─────────────────────────────────────────────────

    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 30_000)

    let res: Response
    try {
      res = await fetch(cfg.url, {
        method,
        headers,
        body: JSON.stringify(payload),
        signal: abort.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      const msg = err instanceof Error ? err.message : String(err)
      // Network / timeout errors are retryable
      throw new WebhookRetryableError(`Network error calling ${cfg.url}: ${msg}`)
    } finally {
      clearTimeout(timer)
    }

    // ── Read response body (truncated) ────────────────────────────────────────

    let responsePayload: Record<string, unknown> | undefined
    try {
      const raw = await res.text()
      const truncated = raw.slice(0, MAX_RESPONSE_BYTES)
      try {
        responsePayload = JSON.parse(truncated) as Record<string, unknown>
      } catch {
        responsePayload = { raw: truncated }
      }
    } catch {
      // Can't read body — non-fatal
    }

    log(`webhook responded`, { status: res.status })

    // ── Handle response status ────────────────────────────────────────────────

    if (res.status >= 500) {
      // 5xx: server-side transient — retryable
      throw new WebhookRetryableError(
        `Webhook endpoint returned ${res.status} — will retry`,
        res.status,
      )
    }

    if (res.status >= 400) {
      // 4xx: client misconfiguration — NOT retryable (retrying won't help)
      throw new Error(
        `Webhook endpoint returned ${res.status} — check URL and auth headers (not retrying)`,
      )
    }

    // 2xx / 3xx — success
    const deliveryId = `delivery-${randomUUID()}`

    const result: import('@fantom/distribution-bus').DistributionResult = {
      externalId: deliveryId,
    }
    if (responsePayload !== undefined) result.responsePayload = responsePayload
    return result
  }
}
