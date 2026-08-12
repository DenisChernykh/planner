import { Module } from '@nestjs/common'

import {
  WorkspaceModule,
  WORKSPACE_MEMBER_RESOLVER,
  type WorkspaceMemberResolver,
} from '@/modules/workspace'
import { DatabaseModule } from '@/platform/database/database.module'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { SystemProductClock } from '@/platform/time/system-product-clock'
import {
  DATABASE_TRANSACTION_PORT,
  type DatabaseTransactionPort,
} from '@/shared/application/database-transaction.port'

import { PLANNING_APPLICATION } from '../application/planning-application'
import {
  PlanningController,
  PlanningDraftController,
} from '../presentation/planning.controller'
import { createPlanningApplication } from './create-planning-application'

@Module({
  imports: [DatabaseModule, WorkspaceModule],
  controllers: [PlanningController, PlanningDraftController],
  providers: [
    {
      provide: PLANNING_APPLICATION,
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
        createPlanningApplication({
          database,
          transaction,
          workspaceMembers,
          clock: new SystemProductClock(),
        }),
    },
  ],
})
export class PlanningModule {}
