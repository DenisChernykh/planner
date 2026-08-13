import type {
  ActorRef,
  ApplicationCommand,
} from '@/shared/application/application-command'

export type BooleanFactValueV1 = {
  readonly kind: 'boolean'
  readonly result: 'done' | 'not_done'
}

export type QuantityFactValueV1 = {
  readonly kind: 'quantity'
  readonly value: string
}

export type RecordFactValueV1 = BooleanFactValueV1 | QuantityFactValueV1

export type RecordFactPayload = {
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly localDate: string
  readonly value: RecordFactValueV1
}

export type RecordFactApplicationCommand = ApplicationCommand<RecordFactPayload>

export type GetFactStateInput = {
  readonly trustedActor: ActorRef
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly localDate: string
}

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

export type FactValueStateV1 =
  BooleanFactStateV1 | QuantityAddFactStateV1 | QuantityLatestFactStateV1

export type FactStateV1 = {
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly localDate: string
  readonly factsRevision: bigint
  readonly fact: FactValueStateV1 | null
}
