import { Injectable } from '@nestjs/common'

import {
  LocalUserProvisioningUnavailableError,
  type LocalUserProvisioningPort,
} from '../application/local-user-provisioning.port'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

@Injectable()
export class PrismaLocalUserProvisioningRepository implements LocalUserProvisioningPort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public async ensureUsers(userIds: readonly string[]): Promise<void> {
    try {
      await this.database.withClient(async (client) => {
        await client.user.createMany({
          data: userIds.map((id) => ({ id })),
          skipDuplicates: true,
        })
      })
    } catch (error: unknown) {
      throw new LocalUserProvisioningUnavailableError({ cause: error })
    }
  }
}
