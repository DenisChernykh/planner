import type {
  ActorRef,
  ApplicationCommand,
} from '@/shared/application/application-command'

import type {
  DraftGoalConfigV1,
  SourceProvenanceV1,
} from '../domain/goal-config'
import type { PublishBlocker } from '../domain/goal-validation'

export type AddDraftGoalPayload = {
  readonly planMonthId: string
  readonly goalDefinitionId: string
  readonly config: DraftGoalConfigV1
  readonly sourceProvenance: SourceProvenanceV1 | null
}
export type UpdateDraftGoalPayload = {
  readonly planMonthId: string
  readonly planGoalId: string
  readonly goalDefinitionVersionId: string
  readonly config: DraftGoalConfigV1
  readonly sourceProvenance: SourceProvenanceV1 | null
}
export type RemoveDraftGoalPayload = {
  readonly planMonthId: string
  readonly planGoalId: string
}
export type ReorderDraftGoalsPayload = {
  readonly planMonthId: string
  readonly orderedPlanGoalIds: readonly string[]
}
export type AddDraftGoalApplicationCommand =
  ApplicationCommand<AddDraftGoalPayload>
export type UpdateDraftGoalApplicationCommand =
  ApplicationCommand<UpdateDraftGoalPayload>
export type RemoveDraftGoalApplicationCommand =
  ApplicationCommand<RemoveDraftGoalPayload>
export type ReorderDraftGoalsApplicationCommand =
  ApplicationCommand<ReorderDraftGoalsPayload>

export type GetDraftEditorInput = {
  readonly trustedActor: ActorRef
  readonly targetMonth: string
}
export type DraftGoalView = {
  readonly planGoalId: string
  readonly goalDefinitionId: string
  readonly goalDefinitionVersionId: string
  readonly goalSeriesId: string
  readonly title: string
  readonly why: string
  readonly category: string
  readonly displayOrder: number
  readonly configRevision: bigint
  readonly config: DraftGoalConfigV1
  readonly sourceProvenance: SourceProvenanceV1 | null
  readonly blockers: readonly PublishBlocker[]
}
export type DraftEditorView = {
  readonly planMonthId: string
  readonly spaceId: string
  readonly targetMonth: string
  readonly status: 'draft'
  readonly focus: string
  readonly planMonthRevision: bigint
  readonly draftRevision: bigint
  readonly goals: readonly DraftGoalView[]
  readonly blockers: readonly PublishBlocker[]
}
