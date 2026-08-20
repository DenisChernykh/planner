import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'

import {
  ClaimDueOccurrences,
  SaveReminderScheduleCommand,
} from '../application'
import { PrismaReminderSchedulePersistence } from '../infrastructure/prisma-reminder-schedule.persistence'

export type RemindersApplication = {
  readonly saveReminderSchedule: SaveReminderScheduleCommand
  readonly claimDueOccurrences: ClaimDueOccurrences
}

export function createRemindersApplication(dependencies: {
  readonly database: PrismaClientProvider
  readonly transaction: DatabaseTransactionPort
  readonly workspaceMembers: WorkspaceMemberResolver
  readonly clock: ProductClock
}): RemindersApplication {
  const persistence = new PrismaReminderSchedulePersistence(
    dependencies.database,
  )
  const executor = new DurableCommandExecutor(
    dependencies.transaction,
    new PrismaCommandReceiptAdapter(dependencies.database),
    dependencies.clock,
  )
  return Object.freeze({
    saveReminderSchedule: new SaveReminderScheduleCommand(
      executor,
      dependencies.workspaceMembers,
      persistence,
    ),
    claimDueOccurrences: new ClaimDueOccurrences(
      persistence,
      dependencies.clock,
      dependencies.transaction,
    ),
  })
}
