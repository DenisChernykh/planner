import { Injectable } from '@nestjs/common'

import type { DatabaseReadinessProbe } from './database.contracts'
import { PrismaClientProvider } from './prisma-client.provider'

@Injectable()
export class PostgresReadinessProbe implements DatabaseReadinessProbe {
  public constructor(
    private readonly provider: PrismaClientProvider,
    private readonly timeoutMs: number,
  ) {}

  public check(signal: AbortSignal): Promise<'up' | 'down'> {
    return this.provider.checkReadiness(signal, this.timeoutMs)
  }
}
