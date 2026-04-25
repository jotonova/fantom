import type { DestinationProvider, DestinationKind } from './types.js'

// ── DistributionBus ────────────────────────────────────────────────────────────
// Registry + dispatcher for destination providers. Mirrors RenderBus shape.

export class DistributionBus {
  private readonly providers: DestinationProvider[] = []

  register(provider: DestinationProvider): this {
    this.providers.push(provider)
    return this
  }

  /**
   * Resolve a provider for the given destination kind.
   *
   * @param kind - The destination kind to publish to
   * @param preferred - Optional provider name override (from tenant_settings)
   * @throws Error if no registered provider can handle the kind
   */
  resolve(kind: DestinationKind, preferred?: string): DestinationProvider {
    if (preferred) {
      const p = this.providers.find((p) => p.name === preferred && p.canHandle(kind))
      if (p) return p
    }

    const fallback = this.providers.find((p) => p.canHandle(kind))
    if (!fallback) {
      throw new Error(`No destination provider registered for kind: ${kind}`)
    }

    return fallback
  }

  registeredNames(): string[] {
    return this.providers.map((p) => p.name)
  }
}
