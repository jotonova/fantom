import type { DestinationProvider, DistributionContext, DistributionResult, DestinationKind } from '@fantom/distribution-bus'

export class YouTubeDestination implements DestinationProvider {
  readonly name = 'youtube'

  canHandle(kind: DestinationKind): boolean {
    return kind === 'youtube'
  }

  async publish(_context: DistributionContext): Promise<DistributionResult> {
    throw new Error(
      'YouTubeDestination: not yet implemented — coming when YouTube OAuth is wired',
    )
  }
}
