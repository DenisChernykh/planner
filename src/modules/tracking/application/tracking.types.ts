import type {
  ActorRef,
  ApplicationCommand,
} from '@/shared/application/application-command'
import type { GoalProgressResult } from '@/modules/progress'

export type BooleanFactValueV1 = {
  readonly kind: 'boolean'
  readonly result: 'done' | 'not_done'
}

export type QuantityFactValueV1 = {
  readonly kind: 'quantity'
  readonly value: string
}

export type RecordFactValueV1 = BooleanFactValueV1 | QuantityFactValueV1

export type ActualTimeFactValueV1 = {
  readonly kind: 'actual_time'
  readonly value: string
}

export type RatingFactValueV1 = {
  readonly kind: 'rating'
  readonly value: number
}

export type RecordSingleFactValueV1 =
  RecordFactValueV1 | ActualTimeFactValueV1 | RatingFactValueV1

export type RecordCheckpointValueV1 =
  BooleanFactValueV1 | ActualTimeFactValueV1 | RatingFactValueV1

export type RecordFactPayload = {
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly localDate: string
  readonly value: RecordFactValueV1
}

export type RecordFactApplicationCommand = ApplicationCommand<RecordFactPayload>

export type RecordTimePayload = {
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly expectationDate: string
  readonly value: string
}

export type RecordTimeApplicationCommand = ApplicationCommand<RecordTimePayload>

export type RecordRatingPayload = {
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly expectationDate: string
  readonly value: number
}

export type RecordRatingApplicationCommand =
  ApplicationCommand<RecordRatingPayload>

export type RecordCheckpointPayload = {
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly expectationDate: string
  readonly checkpointId: string
  readonly value: RecordCheckpointValueV1
}

export type RecordCheckpointApplicationCommand =
  ApplicationCommand<RecordCheckpointPayload>

export type GetFactStateInput = {
  readonly trustedActor: ActorRef
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly localDate: string
}

export type GetGoalProgressInput = {
  readonly trustedActor: ActorRef
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly asOfLocalDate: string
}

export type GoalProgressStateV1 = GoalProgressResult

export type BooleanFactStateV1 = {
  readonly kind: 'boolean'
  readonly factRecordId: string
  readonly revision: bigint
  readonly result: 'done' | 'not_done'
  readonly recordedByMemberId: string
}

export type QuantityAddContributionV1 = {
  readonly contributionId: string
  readonly factRecordId: string
  readonly revision: bigint
  readonly value: string
  readonly recordedByMemberId: string
}

export type QuantityAddFactStateV1 = {
  readonly kind: 'quantity_add'
  readonly contributions: readonly QuantityAddContributionV1[]
}

export type QuantityLatestFactStateV1 = {
  readonly kind: 'quantity_latest'
  readonly factRecordId: string
  readonly revision: bigint
  readonly value: string
  readonly recordedByMemberId: string
}

export type ActualTimeFactStateV1 = {
  readonly kind: 'actual_time'
  readonly factRecordId: string
  readonly revision: bigint
  readonly value: string
  readonly recordedByMemberId: string
}

export type RatingFactStateV1 = {
  readonly kind: 'rating'
  readonly factRecordId: string
  readonly revision: bigint
  readonly value: number
  readonly recordedByMemberId: string
}

export type FactValueStateV1 =
  | BooleanFactStateV1
  | QuantityAddFactStateV1
  | QuantityLatestFactStateV1
  | ActualTimeFactStateV1
  | RatingFactStateV1

export type FactStateV1 = {
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly localDate: string
  readonly factsRevision: bigint
  readonly fact: FactValueStateV1 | null
}
