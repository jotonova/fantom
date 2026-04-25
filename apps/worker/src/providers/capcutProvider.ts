import type { RenderProvider, RenderContext, RenderResult } from '@fantom/render-bus'
import type { JobKind } from '@fantom/db'

// ── CapCutProvider (stub) ─────────────────────────────────────────────────────
// Placeholder for a future CapCut API-based render pipeline.
// Register this with the bus once the implementation is ready.

export class CapCutProvider implements RenderProvider {
  readonly name = 'capcut'

  canHandle(_kind: JobKind): boolean {
    // Not yet implemented — return false so the bus falls through to ffmpeg
    return false
  }

  async render(_context: RenderContext): Promise<RenderResult> {
    throw new Error('CapCutProvider: not yet implemented')
  }
}
