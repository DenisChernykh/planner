import { Module } from '@nestjs/common'

import {
  LOCAL_USER_PROVISIONING_PORT,
  LocalUserProvisioningModule,
} from '@/modules/auth'
import { DatabaseModule } from '@/platform/database/database.module'
import { DATABASE_TRANSACTION_PORT } from '@/shared/application/database-transaction.port'

import { PAIR_WORKSPACE_PORT } from '../application/pair-workspace.port'
import { ProvisionPairUseCase } from '../application/provision-pair.use-case'
import { WORKSPACE_MEMBER_RESOLVER } from '../application/workspace-member-resolver.port'
import { PrismaPairWorkspaceRepository } from '../infrastructure/prisma-pair-workspace.repository'
import { PrismaWorkspaceMemberResolver } from '../infrastructure/prisma-workspace-member.resolver'

@Module({
  imports: [DatabaseModule, LocalUserProvisioningModule],
  providers: [
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
  exports: [WORKSPACE_MEMBER_RESOLVER],
})
export class WorkspaceModule {}
