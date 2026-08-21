import { Module, type DynamicModule } from '@nestjs/common'

import {
  WORKSPACE_MEMBER_RESOLVER,
  WorkspaceModule,
  type WorkspaceMemberResolver,
} from '@/modules/workspace'
import { DatabaseModule } from '@/platform/database/database.module'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { SystemProductClock } from '@/platform/time/system-product-clock'
import {
  DATABASE_TRANSACTION_PORT,
  type DatabaseTransactionPort,
} from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'

import { REMINDERS_APPLICATION } from '../application'
import { ReminderSettingsController } from '../presentation/reminder-settings.controller'
import { createRemindersApplication } from './create-reminders-application'

@Module({
  imports: [DatabaseModule, WorkspaceModule],
  controllers: [ReminderSettingsController],
})
export class RemindersModule {
  public static forRoot(
    clock: ProductClock = new SystemProductClock(),
  ): DynamicModule {
    return {
      module: RemindersModule,
      providers: [
        {
          provide: REMINDERS_APPLICATION,
          inject: [
            PrismaClientProvider,
            DATABASE_TRANSACTION_PORT,
            WORKSPACE_MEMBER_RESOLVER,
          ],
          useFactory: (
            database: PrismaClientProvider,
            transaction: DatabaseTransactionPort,
            workspaceMembers: WorkspaceMemberResolver,
          ) =>
            createRemindersApplication({
              database,
              transaction,
              workspaceMembers,
              clock,
            }),
        },
      ],
      exports: [REMINDERS_APPLICATION],
    }
  }
}
