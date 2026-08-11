import { Inject, Injectable } from '@nestjs/common'

import type { DatabaseRuntimeConfig } from '@/platform/config/runtime-config.types'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'

import { DATABASE_RUNTIME_CONFIG } from './database.tokens'
import { PrismaClientProvider } from './prisma-client.provider'
import { PrismaTransactionContext } from './prisma-transaction.context'

@Injectable()
export class PrismaTransactionAdapter implements DatabaseTransactionPort {
  public constructor(
    private readonly provider: PrismaClientProvider,
    private readonly context: PrismaTransactionContext,
    @Inject(DATABASE_RUNTIME_CONFIG)
    private readonly config: { readonly database: DatabaseRuntimeConfig },
  ) {}

  public run<T>(operation: () => Promise<T>): Promise<T> {
    return this.provider.withClient((client) =>
      this.context.run(client, operation, {
        maxWait: this.config.database.transactionMaxWaitMs,
        timeout: this.config.database.transactionTimeoutMs,
      }),
    )
  }
}
