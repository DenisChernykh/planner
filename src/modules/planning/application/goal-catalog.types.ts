import type {
  ActorRef,
  ApplicationCommand,
} from '@/shared/application/application-command'

export type GoalDefinitionId = string
export type GoalDefinitionVersionId = string
export type GoalSeriesId = string
export type GoalDefinitionState = 'active' | 'archived'
export type SeriesDecision = 'continue' | 'new'

export type GoalMetadata = {
  readonly title: string
  readonly why: string
  readonly category: string
}

export type CreateGoalDefinitionPayload = GoalMetadata
export type CreateGoalDefinitionVersionPayload = GoalMetadata & {
  readonly goalDefinitionId: GoalDefinitionId
  readonly seriesDecision: SeriesDecision
}
export type GoalDefinitionIdentityPayload = {
  readonly goalDefinitionId: GoalDefinitionId
}
export type CopyGoalDefinitionPayload = {
  readonly sourceGoalDefinitionId: GoalDefinitionId
}

export type CreateGoalDefinitionApplicationCommand =
  ApplicationCommand<CreateGoalDefinitionPayload>
export type CreateGoalDefinitionVersionApplicationCommand =
  ApplicationCommand<CreateGoalDefinitionVersionPayload>
export type ArchiveGoalDefinitionApplicationCommand =
  ApplicationCommand<GoalDefinitionIdentityPayload>
export type RestoreGoalDefinitionApplicationCommand =
  ApplicationCommand<GoalDefinitionIdentityPayload>
export type CopyGoalDefinitionApplicationCommand =
  ApplicationCommand<CopyGoalDefinitionPayload>

export type GoalDefinitionVersionView = {
  readonly goalDefinitionVersionId: GoalDefinitionVersionId
  readonly versionNumber: bigint
  readonly goalSeriesId: GoalSeriesId
  readonly seriesDecision: SeriesDecision
  readonly title: string
  readonly why: string
  readonly category: string
}

export type GoalDefinitionSummary = {
  readonly goalDefinitionId: GoalDefinitionId
  readonly state: GoalDefinitionState
  readonly revision: bigint
  readonly currentVersion: GoalDefinitionVersionView
}

export type GoalDefinitionDetail = GoalDefinitionSummary & {
  readonly versions: readonly GoalDefinitionVersionView[]
}

export type GoalDefinitionListState = GoalDefinitionState | 'all'
export type ListGoalDefinitionsInput = {
  readonly trustedActor: ActorRef
  readonly state?: GoalDefinitionListState
}
export type GetGoalDefinitionInput = {
  readonly trustedActor: ActorRef
  readonly goalDefinitionId: GoalDefinitionId
}
