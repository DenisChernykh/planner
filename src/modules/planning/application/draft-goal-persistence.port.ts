import type {
  DraftGoalConfigV1,
  SourceProvenanceV1,
} from '../domain/goal-config'
import type { DraftEditorView } from './draft-goal.types'
import type {
  PlanningCommandIdentity,
  PlanningDraftRef,
} from './plan-draft-persistence.port'

type MutationIdentity = PlanningCommandIdentity & {
  readonly spaceId: string
  readonly memberId: string
  readonly planMonthId: string
  readonly expectedRevision: bigint
}
export type AddDraftGoalPersistenceInput = MutationIdentity & {
  readonly goalDefinitionId: string
  readonly config: DraftGoalConfigV1
  readonly sourceProvenance: SourceProvenanceV1 | null
}
export type UpdateDraftGoalPersistenceInput = MutationIdentity & {
  readonly planGoalId: string
  readonly goalDefinitionVersionId: string
  readonly config: DraftGoalConfigV1
  readonly sourceProvenance: SourceProvenanceV1 | null
}
export type RemoveDraftGoalPersistenceInput = MutationIdentity & {
  readonly planGoalId: string
}
export type ReorderDraftGoalsPersistenceInput = MutationIdentity & {
  readonly orderedPlanGoalIds: readonly string[]
}

export interface DraftGoalPersistencePort {
  add(input: AddDraftGoalPersistenceInput): Promise<PlanningDraftRef>
  update(input: UpdateDraftGoalPersistenceInput): Promise<PlanningDraftRef>
  remove(input: RemoveDraftGoalPersistenceInput): Promise<PlanningDraftRef>
  reorder(input: ReorderDraftGoalsPersistenceInput): Promise<PlanningDraftRef>
  findEditor(
    spaceId: string,
    targetMonth: string,
  ): Promise<DraftEditorView | null>
}
