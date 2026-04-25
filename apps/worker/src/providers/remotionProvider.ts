import type { RenderProvider, RenderContext, RenderResult } from '@fantom/render-bus'
import type { JobKind } from '@fantom/db'

// ── RemotionProvider (stub) ────────────────────────────────────────────────────
// Placeholder for a future Remotion-based render pipeline.
// Register this with the bus once the implementation is ready.

export class RemotionProvider implements RenderProvider {
  readonly name = 'remotion'

  canHandle(_kind: JobKind): boolean {
    // Not yet implemented — return false so the bus falls through to ffmpeg
    return false
  }

  async render(_context: RenderContext): Promise<RenderResult> {
    throw new Error('RemotionProvider: not yet implemented')
  }
}
