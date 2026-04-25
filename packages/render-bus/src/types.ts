import type { JobKind } from '@fantom/db'

// ── CancelledError ─────────────────────────────────────────────────────────────
// Shared across all providers and the worker dispatcher.
// Throwing this signals clean resolution (no BullMQ retry).

export class CancelledError extends Error {
  constructor() {
    super('Job was cancelled')
    this.name = 'CancelledError'
  }
}

// ── RenderContext ──────────────────────────────────────────────────────────────
// Passed to every provider's render() call. Abstracts DB/BullMQ concerns
// so providers only implement media logic.

export interface RenderContext {
  jobId: string
  tenantId: string
  tenantSlug: string
  /** Job input payload — providers cast to their own input type */
  input: Record<string, unknown>
  /** Report progress (0–100). Fire-and-forget — errors are logged, not thrown. */
  onProgress: (pct: number) => void
  /** Throws CancelledError if the job has been cancelled in the DB. */
  checkCancelled: () => Promise<void>
  /** Structured log helper — prefixes entries with [job:<id>] */
  log: (msg: string) => void
}

// ── RenderResult ───────────────────────────────────────────────────────────────
// Returned by provider.render(). The worker dispatcher uses this to create
// the output asset DB record and mark the job complete.

export interface RenderResult {
  /** R2 key of the rendered output file */
  r2Key: string
  mimeType: string
  sizeBytes: number
  /** Seconds of rendered media. Null if not applicable (e.g. image output). */
  durationSeconds: number | null
  width: number | null
  height: number | null
  originalFilename: string
}

// ── RenderProvider ─────────────────────────────────────────────────────────────
// Strategy interface. Each provider is registered with the bus under a name.

export interface RenderProvider {
  /** Unique name for this provider (e.g. 'ffmpeg', 'remotion', 'capcut') */
  readonly name: string
  /** Returns true if this provider can handle the given job kind */
  canHandle(kind: JobKind): boolean
  /** Execute the render pipeline. Throws CancelledError or Error on failure. */
  render(context: RenderContext): Promise<RenderResult>
}
