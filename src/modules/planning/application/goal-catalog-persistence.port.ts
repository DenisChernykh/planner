import type { PlanningCommandIdentity } from './plan-draft-persistence.port'
import type {
  GoalDefinitionDetail,
  GoalDefinitionListState,
  GoalDefinitionState,
  GoalDefinitionSummary,
  GoalMetadata,
  SeriesDecision,
} from './goal-catalog.types'

export type GoalCatalogCommandIdentity = PlanningCommandIdentity & {
  readonly spaceId: string
  readonly memberId: string
}

export type CreateGoalDefinitionPersistenceInput = GoalCatalogCommandIdentity &
  GoalMetadata
export type VersionGoalDefinitionPersistenceInput = GoalCatalogCommandIdentity &
  GoalMetadata & {
    readonly goalDefinitionId: string
    readonly expectedRevision: bigint
    readonly seriesDecision: SeriesDecision
  }
export type ChangeGoalDefinitionStatePersistenceInput =
  GoalCatalogCommandIdentity & {
    readonly goalDefinitionId: string
    readonly expectedRevision: bigint
    readonly requestedState: GoalDefinitionState
  }
export type CopyGoalDefinitionPersistenceInput = GoalCatalogCommandIdentity & {
  readonly sourceGoalDefinitionId: string
  readonly expectedRevision: bigint
}

export type GoalDefinitionRef = {
  readonly goalDefinitionId: string
  readonly revision: bigint
}

export interface GoalCatalogPersistencePort {
  create(
    input: CreateGoalDefinitionPersistenceInput,
  ): Promise<GoalDefinitionRef>
  createVersion(
    input: VersionGoalDefinitionPersistenceInput,
  ): Promise<GoalDefinitionRef>
  changeState(
    input: ChangeGoalDefinitionStatePersistenceInput,
  ): Promise<GoalDefinitionRef>
  copy(input: CopyGoalDefinitionPersistenceInput): Promise<GoalDefinitionRef>
  list(
    spaceId: string,
    state: GoalDefinitionListState,
  ): Promise<readonly GoalDefinitionSummary[]>
  get(
    spaceId: string,
    goalDefinitionId: string,
  ): Promise<GoalDefinitionDetail | null>
}
