import type { ActorRef } from '@/shared/application/application-command'
import type { EvaluateGoalProgressInput } from '@/modules/progress'

import type { FactStateV1, RecordSingleFactValueV1 } from './tracking.types'

export type TrackingRecordCommandType =
  | 'tracking.record-fact.v1'
  | 'tracking.record-time.v1'
  | 'tracking.record-rating.v1'
  | 'tracking.record-checkpoint.v1'
  | 'tracking.record-text.v1'
  | 'tracking.record-checklist-item.v1'
  | 'tracking.record-or-variant.v1'
  | 'tracking.record-composite-occurrence.v1'

export type RecordFactPersistenceInput = {
  readonly actor: ActorRef
  readonly actorScope: string
  readonly commandType: TrackingRecordCommandType
  readonly commandId: string
  readonly occurredAt: Date
  readonly currentLocalDate: string
  readonly spaceId: string
  readonly memberId: string
  readonly expectedRevision: bigint | null
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly localDate: string
  readonly checkpointId: string | null
  readonly checklistItemId: string | null
  readonly orVariantId: string | null
  readonly value: RecordSingleFactValueV1
}

export type FactRecordRef = {
  readonly factRecordId: string
  readonly factRevision: bigint
}

export type TrackingMutationCommandType =
  'tracking.correct-record.v1' | 'tracking.delete-record.v1'

export type MutateFactPersistenceInput = {
  readonly actor: ActorRef
  readonly actorScope: string
  readonly commandType: TrackingMutationCommandType
  readonly commandId: string
  readonly occurredAt: Date
  readonly currentLocalDate: string
  readonly spaceId: string
  readonly memberId: string
  readonly expectedRevision: bigint
  readonly factRecordId: string
  readonly value: RecordSingleFactValueV1 | null
  readonly reason: string
}

export type GetFactStatePersistenceInput = {
  readonly spaceId: string
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly localDate: string
}

export type GetGoalProgressPersistenceInput = {
  readonly spaceId: string
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly asOfLocalDate: string
}

export interface FactPersistencePort {
  record(input: RecordFactPersistenceInput): Promise<FactRecordRef>
  mutate(input: MutateFactPersistenceInput): Promise<FactRecordRef>
  getState(input: GetFactStatePersistenceInput): Promise<FactStateV1 | null>
  getGoalProgressInput(
    input: GetGoalProgressPersistenceInput,
  ): Promise<EvaluateGoalProgressInput | null>
}
