import type { ActorRef } from '@/shared/application/application-command'

import type { CloseDayPreviewItemV1 } from './close-day.types'

export type CloseDayPreviewPersistenceInput = {
  readonly spaceId: string
  readonly memberId: string
  readonly publicationId: string
  readonly localDate: string
  readonly currentLocalDate: string
}

export type CloseDayReadyPersistenceState = {
  readonly state: 'ready'
  readonly factsRevision: bigint
  readonly unresolved: readonly CloseDayPreviewItemV1[]
}

export type CloseDayClosedPersistenceState = {
  readonly state: 'closed'
  readonly dayCloseId: string
  readonly revision: bigint
  readonly closedAt: Date
  readonly closedCount: number
}

export type CloseDayPreviewPersistenceState =
  CloseDayReadyPersistenceState | CloseDayClosedPersistenceState

export type CloseDayPersistenceInput = CloseDayPreviewPersistenceInput & {
  readonly actor: ActorRef
  readonly actorScope: string
  readonly commandId: string
  readonly occurredAt: Date
  readonly expectedRevision: bigint
  readonly previewSchemaVersion: string
  readonly previewHashVersion: string
  readonly previewHash: string
}

export type DayCloseRef = {
  readonly dayCloseId: string
  readonly factsRevision: bigint
}

export interface CloseDayPersistencePort {
  preview(
    input: CloseDayPreviewPersistenceInput,
  ): Promise<CloseDayPreviewPersistenceState>
  close(input: CloseDayPersistenceInput): Promise<DayCloseRef>
}
