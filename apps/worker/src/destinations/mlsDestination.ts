import type { DestinationProvider, DistributionContext, DistributionResult, DestinationKind } from '@fantom/distribution-bus'

export class MlsDestination implements DestinationProvider {
  readonly name = 'mls'

  canHandle(kind: DestinationKind): boolean {
    return kind === 'mls'
  }

  async publish(_context: DistributionContext): Promise<DistributionResult> {
    throw new Error('MlsDestination: not yet implemented')
  }
}
