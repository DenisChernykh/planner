import { Module, type DynamicModule } from '@nestjs/common'

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
import type { ProductClock } from '@/shared/application/product-clock'

import { TRACKING_APPLICATION } from '../application/tracking-application'
import { CompositeFactController } from '../presentation/composite-fact.controller'
import { FactMaintenanceController } from '../presentation/fact-maintenance.controller'
import { TrackingQueryController } from '../presentation/tracking-query.controller'
import { ScalarFactController } from '../presentation/scalar-fact.controller'
import { createTrackingApplication } from './create-tracking-application'

@Module({
  imports: [DatabaseModule, WorkspaceModule],
  controllers: [
    TrackingQueryController,
    ScalarFactController,
    CompositeFactController,
    FactMaintenanceController,
  ],
})
export class TrackingModule {
  public static forRoot(
    clock: ProductClock = new SystemProductClock(),
  ): DynamicModule {
    return {
      module: TrackingModule,
      providers: [
        {
          provide: TRACKING_APPLICATION,
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
            createTrackingApplication({
              database,
              transaction,
              workspaceMembers,
              clock,
            }),
        },
      ],
    }
  }
}
