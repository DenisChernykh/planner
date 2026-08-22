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

import { REPORTING_APPLICATION } from '../application/reporting-application'
import { ReportingController } from '../presentation/reporting.controller'
import { createReportingApplication } from './create-reporting-application'

@Module({
  imports: [DatabaseModule, WorkspaceModule],
  controllers: [ReportingController],
})
export class ReportingModule {
  public static forRoot(
    clock: ProductClock = new SystemProductClock(),
  ): DynamicModule {
    return {
      module: ReportingModule,
      providers: [
        {
          provide: REPORTING_APPLICATION,
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
            createReportingApplication({
              database,
              transaction,
              workspaceMembers,
              clock,
            }),
        },
      ],
      exports: [REPORTING_APPLICATION],
    }
  }
}
