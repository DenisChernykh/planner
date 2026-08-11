import { Module } from '@nestjs/common'

import { LOCAL_USER_PROVISIONING_PORT } from '../application/local-user-provisioning.port'
import { PrismaLocalUserProvisioningRepository } from '../infrastructure/prisma-local-user-provisioning.repository'
import { DatabaseModule } from '@/platform/database/database.module'

@Module({
  imports: [DatabaseModule],
  providers: [
    PrismaLocalUserProvisioningRepository,
    {
      provide: LOCAL_USER_PROVISIONING_PORT,
      useExisting: PrismaLocalUserProvisioningRepository,
    },
  ],
  exports: [LOCAL_USER_PROVISIONING_PORT],
})
export class LocalUserProvisioningModule {}
