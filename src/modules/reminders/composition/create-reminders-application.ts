import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'

import {
  BuildReminderIntentCommand,
  DeliverReminderCommand,
  ClaimDueOccurrences,
  GetDeliveryStatusQuery,
  GetReminderSettingsQuery,
  ReminderIntentDependencyUnavailableError,
  RunDueRemindersCycle,
  SaveReminderScheduleCommand,
  type RemindersApplication,
  type ReminderTodayReadPort,
} from '../application'
import {
  PrismaNotificationIntentPersistence,
  PrismaNotificationAttemptPersistence,
  PrismaReminderSettingsReadPersistence,
  PrismaReminderSchedulePersistence,
} from '../infrastructure'
import type { ReminderIntentPersistencePort } from '../application/reminder.types'
import type {
  ReminderAttemptPersistencePort,
  ReminderDeliveryTransportPort,
} from '../application/reminder.types'
import type { WorkspaceTelegramRecipientResolver } from '@/modules/workspace/application/workspace-member-resolver.port'

export function createRemindersApplication(dependencies: {
  readonly database: PrismaClientProvider
  readonly transaction: DatabaseTransactionPort
  readonly workspaceMembers: WorkspaceMemberResolver
  readonly clock: ProductClock
  readonly today?: ReminderTodayReadPort
  readonly telegramRecipientResolver?: WorkspaceTelegramRecipientResolver
  readonly deliveryTransport?: ReminderDeliveryTransportPort
}): RemindersApplication {
  const persistence = new PrismaReminderSchedulePersistence(
    dependencies.database,
  )
  const reads = new PrismaReminderSettingsReadPersistence(dependencies.database)
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
  const attemptPersistence: ReminderAttemptPersistencePort =
    new PrismaNotificationAttemptPersistence(dependencies.database)
  const deliverReminder =
    dependencies.telegramRecipientResolver !== undefined &&
    dependencies.deliveryTransport !== undefined
      ? new DeliverReminderCommand(
          attemptPersistence,
          dependencies.telegramRecipientResolver,
          dependencies.deliveryTransport,
          dependencies.transaction,
          dependencies.clock,
        )
      : undefined
  const application = {
    saveReminderSchedule: new SaveReminderScheduleCommand(
      executor,
      dependencies.workspaceMembers,
      persistence,
    ),
    getReminderSettings: new GetReminderSettingsQuery(
      dependencies.workspaceMembers,
      reads,
    ),
    getDeliveryStatus: new GetDeliveryStatusQuery(
      dependencies.workspaceMembers,
      reads,
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
    ...(deliverReminder === undefined ? {} : { deliverReminder }),
  }
  return Object.freeze({
    ...application,
    ...(deliverReminder === undefined
      ? {}
      : {
          runDueReminders: new RunDueRemindersCycle(
            application.claimDueOccurrences,
            application.buildReminderIntent,
            deliverReminder,
          ),
        }),
  })
}
