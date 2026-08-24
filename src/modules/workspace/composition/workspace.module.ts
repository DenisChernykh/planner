import { Module } from '@nestjs/common'

import {
  LOCAL_USER_PROVISIONING_PORT,
  LocalUserProvisioningModule,
} from '@/modules/auth'
import { DatabaseModule } from '@/platform/database/database.module'
import { DATABASE_TRANSACTION_PORT } from '@/shared/application/database-transaction.port'

import { PAIR_WORKSPACE_PORT } from '../application/pair-workspace.port'
import { CURRENT_WORKSPACE_READ_PORT } from '../application/current-workspace.read.port'
import { GetCurrentWorkspaceQuery } from '../application/get-current-workspace.query'
import { ProvisionPairUseCase } from '../application/provision-pair.use-case'
import {
  WORKSPACE_MEMBER_RESOLVER,
  WORKSPACE_TELEGRAM_RECIPIENT_RESOLVER,
} from '../application/workspace-member-resolver.port'
import { PrismaPairWorkspaceRepository } from '../infrastructure/prisma-pair-workspace.repository'
import { PrismaCurrentWorkspaceRead } from '../infrastructure/prisma-current-workspace.read'
import { PrismaWorkspaceMemberResolver } from '../infrastructure/prisma-workspace-member.resolver'
import { WorkspaceController } from '../presentation/workspace.controller'

@Module({
  imports: [DatabaseModule, LocalUserProvisioningModule],
  controllers: [WorkspaceController],
  providers: [
    PrismaCurrentWorkspaceRead,
    {
      provide: CURRENT_WORKSPACE_READ_PORT,
      useExisting: PrismaCurrentWorkspaceRead,
    },
    {
      provide: GetCurrentWorkspaceQuery,
      inject: [CURRENT_WORKSPACE_READ_PORT],
      useFactory: (
        workspace: ConstructorParameters<typeof GetCurrentWorkspaceQuery>[0],
      ) => new GetCurrentWorkspaceQuery(workspace),
    },
    PrismaPairWorkspaceRepository,
    {
      provide: PAIR_WORKSPACE_PORT,
      useExisting: PrismaPairWorkspaceRepository,
    },
    PrismaWorkspaceMemberResolver,
    {
      provide: WORKSPACE_MEMBER_RESOLVER,
      useExisting: PrismaWorkspaceMemberResolver,
    },
    {
      provide: WORKSPACE_TELEGRAM_RECIPIENT_RESOLVER,
      useExisting: PrismaWorkspaceMemberResolver,
    },
    {
      provide: ProvisionPairUseCase,
      inject: [
        DATABASE_TRANSACTION_PORT,
        LOCAL_USER_PROVISIONING_PORT,
        PAIR_WORKSPACE_PORT,
      ],
      useFactory: (
        ...dependencies: ConstructorParameters<typeof ProvisionPairUseCase>
      ) => new ProvisionPairUseCase(...dependencies),
    },
  ],
  exports: [WORKSPACE_MEMBER_RESOLVER, WORKSPACE_TELEGRAM_RECIPIENT_RESOLVER],
})
export class WorkspaceModule {}
