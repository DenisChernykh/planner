import type { CreateEmptyDraftCommand } from './create-empty-draft.command'
import type { BuildPublicationPreviewQuery } from './build-publication-preview.query'
import type { GetDraftQuery } from './get-draft.query'
import type {
  AddDraftGoalCommand,
  RemoveDraftGoalCommand,
  ReorderDraftGoalsCommand,
  UpdateDraftGoalCommand,
} from './draft-goal.commands'
import type { GetDraftEditorQuery } from './get-draft-editor.query'
import type {
  ArchiveGoalDefinitionCommand,
  CopyGoalDefinitionCommand,
  CreateGoalDefinitionCommand,
  CreateGoalDefinitionVersionCommand,
  RestoreGoalDefinitionCommand,
} from './goal-catalog.commands'
import type {
  GetGoalDefinitionQuery,
  ListGoalDefinitionsQuery,
} from './goal-catalog.queries'
import type { UpdateMonthFocusCommand } from './update-month-focus.command'
import type { PublishMonthCommand } from './publish-month.command'
import type { GetPublishedSnapshotQuery } from './get-published-snapshot.query'
import type { GetActiveMonthQuery } from './get-active-month.query'
import type { CancelPublicationCommand } from './cancel-publication.command'
import type { RepublishMonthCommand } from './republish-month.command'

export const PLANNING_APPLICATION: unique symbol = Symbol(
  'PLANNING_APPLICATION',
)

export type PlanningApplication = {
  readonly createEmptyDraft: CreateEmptyDraftCommand
  readonly updateMonthFocus: UpdateMonthFocusCommand
  readonly getDraft: GetDraftQuery
  readonly getDraftEditor: GetDraftEditorQuery
  readonly buildPublicationPreview: BuildPublicationPreviewQuery
  readonly publishMonth: PublishMonthCommand
  readonly cancelPublication: CancelPublicationCommand
  readonly republishMonth: RepublishMonthCommand
  readonly getPublishedSnapshot: GetPublishedSnapshotQuery
  readonly getActiveMonth: GetActiveMonthQuery
  readonly addDraftGoal: AddDraftGoalCommand
  readonly updateDraftGoal: UpdateDraftGoalCommand
  readonly removeDraftGoal: RemoveDraftGoalCommand
  readonly reorderDraftGoals: ReorderDraftGoalsCommand
  readonly createGoalDefinition: CreateGoalDefinitionCommand
  readonly createGoalDefinitionVersion: CreateGoalDefinitionVersionCommand
  readonly archiveGoalDefinition: ArchiveGoalDefinitionCommand
  readonly restoreGoalDefinition: RestoreGoalDefinitionCommand
  readonly copyGoalDefinition: CopyGoalDefinitionCommand
  readonly listGoalDefinitions: ListGoalDefinitionsQuery
  readonly getGoalDefinition: GetGoalDefinitionQuery
}
