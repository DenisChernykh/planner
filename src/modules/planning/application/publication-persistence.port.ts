import type { ActorRef } from '@/shared/application/application-command'

import type { PublishedSnapshot } from '../domain/publication'

export type PublishMonthPersistenceInput = {
  readonly actor: ActorRef
  readonly actorScope: string
  readonly commandType: 'planning.publish-month.v1'
  readonly commandId: string
  readonly occurredAt: Date
  readonly localDate: string
  readonly spaceId: string
  readonly memberId: string
  readonly planMonthId: string
  readonly expectedDraftRevision: bigint
  readonly previewSchemaVersion: string
  readonly previewHashVersion: string
  readonly previewHash: string
}

export type PublicationRef = {
  readonly publicationId: string
  readonly publicationRevision: bigint
}

export interface PublicationPersistencePort {
  publish(input: PublishMonthPersistenceInput): Promise<PublicationRef>
  findPublished(
    spaceId: string,
    publicationId: string,
  ): Promise<PublishedSnapshot | null>
  findActive(
    spaceId: string,
    localDate: string,
  ): Promise<PublishedSnapshot | null>
}
