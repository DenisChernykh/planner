import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'

import {
  BuildReminderIntentCommand,
  ClaimDueOccurrences,
  ReminderIntentDependencyUnavailableError,
  SaveReminderScheduleCommand,
  type ReminderTodayReadPort,
} from '../application'
import {
  PrismaNotificationIntentPersistence,
  PrismaReminderSchedulePersistence,
} from '../infrastructure'
import type { ReminderIntentPersistencePort } from '../application/reminder.types'

export type RemindersApplication = {
  readonly saveReminderSchedule: SaveReminderScheduleCommand
  readonly claimDueOccurrences: ClaimDueOccurrences
  readonly buildReminderIntent: BuildReminderIntentCommand
}

export function createRemindersApplication(dependencies: {
  readonly database: PrismaClientProvider
  readonly transaction: DatabaseTransactionPort
  readonly workspaceMembers: WorkspaceMemberResolver
  readonly clock: ProductClock
  readonly today?: ReminderTodayReadPort
}): RemindersApplication {
  const persistence = new PrismaReminderSchedulePersistence(
    dependencies.database,
  )
  const executor = new DurableCommandExecutor(
    dependencies.transaction,
    new PrismaCommandReceiptAdapter(dependencies.database),
    dependencies.clock,
  )
  const today: ReminderTodayReadPort = dependencies.today ?? {
    getToday: () =>
      Promise.reject(new ReminderIntentDependencyUnavailableError()),
  }
  const intentPersistence: ReminderIntentPersistencePort =
    new PrismaNotificationIntentPersistence(dependencies.database)
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
    buildReminderIntent: new BuildReminderIntentCommand(
      today,
      intentPersistence,
      dependencies.transaction,
      dependencies.clock,
    ),
  })
}
