import type { DestinationProvider, DistributionContext, DistributionResult, DestinationKind } from '@fantom/distribution-bus'

export class InstagramDestination implements DestinationProvider {
  readonly name = 'instagram'

  canHandle(kind: DestinationKind): boolean {
    return kind === 'instagram'
  }

  async publish(_context: DistributionContext): Promise<DistributionResult> {
    throw new Error('InstagramDestination: not yet implemented')
  }
}
