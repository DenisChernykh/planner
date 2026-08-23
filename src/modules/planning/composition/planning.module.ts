import { Module, type DynamicModule } from '@nestjs/common'

import {
  WorkspaceModule,
  WORKSPACE_MEMBER_RESOLVER,
  type WorkspaceMemberResolver,
} from '@/modules/workspace'
import { DatabaseModule } from '@/platform/database/database.module'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { SystemProductClock } from '@/platform/time/system-product-clock'
import type { ProductClock } from '@/shared/application/product-clock'
import {
  REPORTING_APPLICATION,
  ReportingModule,
  type ReportingApplication,
} from '@/modules/reporting'
import {
  DATABASE_TRANSACTION_PORT,
  type DatabaseTransactionPort,
} from '@/shared/application/database-transaction.port'

import { PLANNING_APPLICATION } from '../application/planning-application'
import {
  PlanningController,
  PlanningDraftController,
  PlanningMonthController,
  PlanningPublicationController,
} from '../presentation/planning.controller'
import { createPlanningApplication } from './create-planning-application'

@Module({})
export class PlanningModule {
  public static forRoot(reportingClock?: ProductClock): DynamicModule {
    return {
      module: PlanningModule,
      imports: [
        DatabaseModule,
        WorkspaceModule,
        ReportingModule.forRoot(reportingClock),
      ],
      controllers: [
        PlanningController,
        PlanningDraftController,
        PlanningPublicationController,
        PlanningMonthController,
      ],
      providers: [
        {
          provide: PLANNING_APPLICATION,
          inject: [
            PrismaClientProvider,
            DATABASE_TRANSACTION_PORT,
            WORKSPACE_MEMBER_RESOLVER,
            REPORTING_APPLICATION,
          ],
          useFactory: (
            database: PrismaClientProvider,
            transaction: DatabaseTransactionPort,
            workspaceMembers: WorkspaceMemberResolver,
            reporting: ReportingApplication,
          ) =>
            createPlanningApplication({
              database,
              transaction,
              workspaceMembers,
              clock: new SystemProductClock(),
              closeMonthReport: reporting.buildCloseMonthReport,
            }),
        },
      ],
    }
  }
}
