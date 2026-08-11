import { Module } from '@nestjs/common'

import { RuntimeConfigService } from '@/platform/config/runtime-config.service'
import { DATABASE_TRANSACTION_PORT } from '@/shared/application/database-transaction.port'

import {
  DATABASE_LIFECYCLE,
  DATABASE_READINESS_PROBE,
  DATABASE_RUNTIME_CONFIG,
} from './database.tokens'
import { PostgresReadinessProbe } from './postgres-readiness.probe'
import { PrismaClientProvider } from './prisma-client.provider'
import { PrismaDatabaseLifecycle } from './prisma-database.lifecycle'
import { PrismaTransactionAdapter } from './prisma-transaction.adapter'
import { PrismaTransactionContext } from './prisma-transaction.context'

@Module({
  providers: [
    {
      provide: DATABASE_RUNTIME_CONFIG,
      inject: [RuntimeConfigService],
      useFactory: (config: RuntimeConfigService) =>
        Object.freeze({ database: config.database }),
    },
    PrismaTransactionContext,
    PrismaClientProvider,
    PrismaDatabaseLifecycle,
    PrismaTransactionAdapter,
    {
      provide: PostgresReadinessProbe,
      inject: [PrismaClientProvider, DATABASE_RUNTIME_CONFIG],
      useFactory: (
        provider: PrismaClientProvider,
        config: { readonly database: { readonly healthTimeoutMs: number } },
      ) =>
        new PostgresReadinessProbe(provider, config.database.healthTimeoutMs),
    },
    { provide: DATABASE_LIFECYCLE, useExisting: PrismaDatabaseLifecycle },
    { provide: DATABASE_READINESS_PROBE, useExisting: PostgresReadinessProbe },
    {
      provide: DATABASE_TRANSACTION_PORT,
      useExisting: PrismaTransactionAdapter,
    },
  ],
  exports: [
    PrismaClientProvider,
    PrismaTransactionContext,
    DATABASE_LIFECYCLE,
    DATABASE_READINESS_PROBE,
    DATABASE_TRANSACTION_PORT,
  ],
})
export class DatabaseModule {}
