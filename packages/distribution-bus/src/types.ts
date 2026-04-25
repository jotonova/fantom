// ── CancelledError ─────────────────────────────────────────────────────────────

export class CancelledError extends Error {
  constructor(message = 'Distribution was cancelled') {
    super(message)
    this.name = 'CancelledError'
  }
}

// ── DestinationKind ────────────────────────────────────────────────────────────

export type DestinationKind = 'webhook' | 'youtube' | 'facebook' | 'instagram' | 'mls'

// ── DistributionContext ────────────────────────────────────────────────────────
// Passed to every provider's publish() call. Abstracts DB/BullMQ concerns.

export interface DistributionContext {
  distributionId: string
  tenantId: string
  jobId: string
  asset: {
    id: string
    publicUrl: string
    width: number | null
    height: number | null
    durationSeconds: number | null
    sizeBytes: number
    mimeType: string
    originalFilename: string
  }
  /** Destination-specific config from distributions.config */
  config: Record<string, unknown>
  /** Report progress (0–100) with optional label. Fire-and-forget. */
  onProgress: (progress: number, label?: string) => Promise<void>
  /** Throws CancelledError if the distribution has been cancelled in the DB. */
  checkCancelled: () => Promise<void>
  /** Structured log — prefixes entries with [dist:<id>] */
  log: (message: string, data?: Record<string, unknown>) => void
}

// ── DistributionResult ─────────────────────────────────────────────────────────

export interface DistributionResult {
  /** The destination's reference (e.g. YouTube video ID, webhook delivery ID) */
  externalId?: string
  /** The public URL on the destination (e.g. YouTube watch URL) */
  externalUrl?: string
  /** What the destination returned — stored in distributions.response_payload */
  responsePayload?: Record<string, unknown>
}

// ── DestinationProvider ────────────────────────────────────────────────────────
// Strategy interface — each provider is registered with the DistributionBus.

export interface DestinationProvider {
  readonly name: string

  canHandle(kind: DestinationKind): boolean
  publish(context: DistributionContext): Promise<DistributionResult>

  /** Called before publish() — optional setup or status logging */
  onStart?: (context: DistributionContext) => Promise<void>
  /** Called after publish() succeeds */
  onComplete?: (context: DistributionContext, result: DistributionResult) => Promise<void>
  /** Called when publish() throws */
  onError?: (context: DistributionContext, error: Error) => Promise<void>
}
