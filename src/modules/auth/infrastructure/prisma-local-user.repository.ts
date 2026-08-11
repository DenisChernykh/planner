import { Injectable } from '@nestjs/common'

import { AuthDependencyUnavailableError } from '../application/auth-errors'
import type { LocalUserPort } from '../application/local-user.port'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

@Injectable()
export class PrismaLocalUserRepository implements LocalUserPort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public async exists(userId: string): Promise<boolean> {
    try {
      const user = await this.database.withClient((client) =>
        client.user.findUnique({ where: { id: userId }, select: { id: true } }),
      )
      return user !== null
    } catch (error: unknown) {
      throw new AuthDependencyUnavailableError({ cause: error })
    }
  }
}
