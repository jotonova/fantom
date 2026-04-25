import type { JobKind } from '@fantom/db'
import type { RenderProvider } from './types.js'

// ── RenderBus ──────────────────────────────────────────────────────────────────
// Registry + dispatcher for render providers.
// Providers are registered at startup. At dispatch time, resolve() picks the
// preferred provider (by name) if it can handle the job kind, otherwise falls
// back to the first registered provider that can.

export class RenderBus {
  private readonly providers: RenderProvider[] = []

  register(provider: RenderProvider): this {
    this.providers.push(provider)
    return this
  }

  /**
   * Resolve a provider for the given job kind.
   *
   * @param kind - The job kind to render
   * @param preferred - Optional provider name from tenant_settings — used first
   *   if that provider can handle the kind; otherwise ignored.
   * @throws Error if no registered provider can handle the kind
   */
  resolve(kind: JobKind, preferred?: string): RenderProvider {
    if (preferred) {
      const p = this.providers.find((p) => p.name === preferred && p.canHandle(kind))
      if (p) return p
    }

    const fallback = this.providers.find((p) => p.canHandle(kind))
    if (!fallback) {
      throw new Error(`No render provider registered for job kind: ${kind}`)
    }

    return fallback
  }

  /** Returns all registered provider names — useful for health checks / logging. */
  registeredNames(): string[] {
    return this.providers.map((p) => p.name)
  }
}
