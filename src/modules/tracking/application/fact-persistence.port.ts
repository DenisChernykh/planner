import type { ActorRef } from '@/shared/application/application-command'

import type { FactStateV1, RecordFactValueV1 } from './tracking.types'

export type RecordFactPersistenceInput = {
  readonly actor: ActorRef
  readonly actorScope: string
  readonly commandType: 'tracking.record-fact.v1'
  readonly commandId: string
  readonly occurredAt: Date
  readonly currentLocalDate: string
  readonly spaceId: string
  readonly memberId: string
  readonly expectedRevision: bigint | null
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly localDate: string
  readonly value: RecordFactValueV1
}

export type FactRecordRef = {
  readonly factRecordId: string
  readonly factRevision: bigint
}

export type GetFactStatePersistenceInput = {
  readonly spaceId: string
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly localDate: string
}

export interface FactPersistencePort {
  record(input: RecordFactPersistenceInput): Promise<FactRecordRef>
  getState(input: GetFactStatePersistenceInput): Promise<FactStateV1 | null>
}
