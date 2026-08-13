import type { ActorRef } from '@/shared/application/application-command'

import type { PublishedSnapshot } from '../domain/publication'

export type PublishMonthPersistenceInput = {
  readonly actor: ActorRef
  readonly actorScope: string
  readonly commandType:
    'planning.publish-month.v1' | 'planning.republish-month.v1'
  readonly publicationMode: 'publish' | 'republish'
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

export type CancelPublicationPersistenceInput = {
  readonly actor: ActorRef
  readonly actorScope: string
  readonly commandType: 'planning.cancel-publication.v1'
  readonly commandId: string
  readonly occurredAt: Date
  readonly localDate: string
  readonly spaceId: string
  readonly memberId: string
  readonly planMonthId: string
  readonly publicationId: string
  readonly expectedPlanMonthRevision: bigint
}

export type PublicationRef = {
  readonly publicationId: string
  readonly publicationRevision: bigint
}

export type PlanMonthRef = {
  readonly planMonthId: string
  readonly planMonthRevision: bigint
}

export interface PublicationPersistencePort {
  publish(input: PublishMonthPersistenceInput): Promise<PublicationRef>
  cancel(input: CancelPublicationPersistenceInput): Promise<PlanMonthRef>
  findPublished(
    spaceId: string,
    publicationId: string,
  ): Promise<PublishedSnapshot | null>
  findActive(
    spaceId: string,
    localDate: string,
  ): Promise<PublishedSnapshot | null>
}
