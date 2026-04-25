import type { DestinationProvider, DistributionContext, DistributionResult, DestinationKind } from '@fantom/distribution-bus'

export class FacebookDestination implements DestinationProvider {
  readonly name = 'facebook'

  canHandle(kind: DestinationKind): boolean {
    return kind === 'facebook'
  }

  async publish(_context: DistributionContext): Promise<DistributionResult> {
    throw new Error('FacebookDestination: not yet implemented')
  }
}
