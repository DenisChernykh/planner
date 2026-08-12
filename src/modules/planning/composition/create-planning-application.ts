import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'
import type { ProductClock } from '@/shared/application/product-clock'

import { CreateEmptyDraftCommand } from '../application/create-empty-draft.command'
import {
  AddDraftGoalCommand,
  RemoveDraftGoalCommand,
  ReorderDraftGoalsCommand,
  UpdateDraftGoalCommand,
} from '../application/draft-goal.commands'
import { GetDraftEditorQuery } from '../application/get-draft-editor.query'
import {
  ArchiveGoalDefinitionCommand,
  CopyGoalDefinitionCommand,
  CreateGoalDefinitionCommand,
  CreateGoalDefinitionVersionCommand,
  RestoreGoalDefinitionCommand,
} from '../application/goal-catalog.commands'
import {
  GetGoalDefinitionQuery,
  ListGoalDefinitionsQuery,
} from '../application/goal-catalog.queries'
import { GetDraftQuery } from '../application/get-draft.query'
import type { PlanningApplication } from '../application/planning-application'
import { UpdateMonthFocusCommand } from '../application/update-month-focus.command'
import { PrismaPlanDraftPersistence } from '../infrastructure/prisma-plan-draft.persistence'
import { PrismaDraftGoalPersistence } from '../infrastructure/prisma-draft-goal.persistence'
import { PrismaGoalCatalogPersistence } from '../infrastructure/prisma-goal-catalog.persistence'

export function createPlanningApplication(dependencies: {
  readonly database: PrismaClientProvider
  readonly transaction: DatabaseTransactionPort
  readonly workspaceMembers: WorkspaceMemberResolver
  readonly clock: ProductClock
}): PlanningApplication {
  const drafts = new PrismaPlanDraftPersistence(dependencies.database)
  const draftGoals = new PrismaDraftGoalPersistence(dependencies.database)
  const catalog = new PrismaGoalCatalogPersistence(dependencies.database)
  const executor = new DurableCommandExecutor(
    dependencies.transaction,
    new PrismaCommandReceiptAdapter(dependencies.database),
    dependencies.clock,
  )
  return Object.freeze({
    createEmptyDraft: new CreateEmptyDraftCommand(
      executor,
      dependencies.workspaceMembers,
      drafts,
    ),
    updateMonthFocus: new UpdateMonthFocusCommand(
      executor,
      dependencies.workspaceMembers,
      drafts,
    ),
    getDraft: new GetDraftQuery(dependencies.workspaceMembers, drafts),
    getDraftEditor: new GetDraftEditorQuery(
      dependencies.workspaceMembers,
      draftGoals,
    ),
    addDraftGoal: new AddDraftGoalCommand(
      executor,
      dependencies.workspaceMembers,
      draftGoals,
    ),
    updateDraftGoal: new UpdateDraftGoalCommand(
      executor,
      dependencies.workspaceMembers,
      draftGoals,
    ),
    removeDraftGoal: new RemoveDraftGoalCommand(
      executor,
      dependencies.workspaceMembers,
      draftGoals,
    ),
    reorderDraftGoals: new ReorderDraftGoalsCommand(
      executor,
      dependencies.workspaceMembers,
      draftGoals,
    ),
    createGoalDefinition: new CreateGoalDefinitionCommand(
      executor,
      dependencies.workspaceMembers,
      catalog,
    ),
    createGoalDefinitionVersion: new CreateGoalDefinitionVersionCommand(
      executor,
      dependencies.workspaceMembers,
      catalog,
    ),
    archiveGoalDefinition: new ArchiveGoalDefinitionCommand(
      executor,
      dependencies.workspaceMembers,
      catalog,
    ),
    restoreGoalDefinition: new RestoreGoalDefinitionCommand(
      executor,
      dependencies.workspaceMembers,
      catalog,
    ),
    copyGoalDefinition: new CopyGoalDefinitionCommand(
      executor,
      dependencies.workspaceMembers,
      catalog,
    ),
    listGoalDefinitions: new ListGoalDefinitionsQuery(
      dependencies.workspaceMembers,
      catalog,
    ),
    getGoalDefinition: new GetGoalDefinitionQuery(
      dependencies.workspaceMembers,
      catalog,
    ),
  })
}
