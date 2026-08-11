import type { CreateEmptyDraftCommand } from './create-empty-draft.command'
import type { GetDraftQuery } from './get-draft.query'
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

export const PLANNING_APPLICATION: unique symbol = Symbol(
  'PLANNING_APPLICATION',
)

export type PlanningApplication = {
  readonly createEmptyDraft: CreateEmptyDraftCommand
  readonly updateMonthFocus: UpdateMonthFocusCommand
  readonly getDraft: GetDraftQuery
  readonly createGoalDefinition: CreateGoalDefinitionCommand
  readonly createGoalDefinitionVersion: CreateGoalDefinitionVersionCommand
  readonly archiveGoalDefinition: ArchiveGoalDefinitionCommand
  readonly restoreGoalDefinition: RestoreGoalDefinitionCommand
  readonly copyGoalDefinition: CopyGoalDefinitionCommand
  readonly listGoalDefinitions: ListGoalDefinitionsQuery
  readonly getGoalDefinition: GetGoalDefinitionQuery
}
