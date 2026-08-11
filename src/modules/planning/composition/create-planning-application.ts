import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'
import type { ProductClock } from '@/shared/application/product-clock'

import { CreateEmptyDraftCommand } from '../application/create-empty-draft.command'
import { GetDraftQuery } from '../application/get-draft.query'
import { UpdateMonthFocusCommand } from '../application/update-month-focus.command'
import { PrismaPlanDraftPersistence } from '../infrastructure/prisma-plan-draft.persistence'

export type PlanningApplication = {
  readonly createEmptyDraft: CreateEmptyDraftCommand
  readonly updateMonthFocus: UpdateMonthFocusCommand
  readonly getDraft: GetDraftQuery
}

export function createPlanningApplication(dependencies: {
  readonly database: PrismaClientProvider
  readonly transaction: DatabaseTransactionPort
  readonly workspaceMembers: WorkspaceMemberResolver
  readonly clock: ProductClock
}): PlanningApplication {
  const drafts = new PrismaPlanDraftPersistence(dependencies.database)
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
  })
}
