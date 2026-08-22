import { AsyncLocalStorage } from 'node:async_hooks'

import { Injectable } from '@nestjs/common'

import type { Prisma, PrismaClient } from '@/generated/prisma/client'
import { DatabaseTransactionRollbackOnlyError } from '@/shared/application/database-transaction.port'

interface ActiveTransaction {
  readonly client: Prisma.TransactionClient
  rollbackOnly: boolean
  rollbackCause?: unknown
}

export interface PrismaTransactionRunOptions {
  readonly maxWait: number
  readonly timeout: number
  readonly beforeOperation?:
    ((client: Prisma.TransactionClient) => Promise<void>) | undefined
}

@Injectable()
export class PrismaTransactionContext {
  private readonly storage = new AsyncLocalStorage<ActiveTransaction>()

  public withClient<T>(
    root: PrismaClient,
    operation: (client: PrismaClient | Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return operation(this.storage.getStore()?.client ?? root)
  }

  public run<T>(
    root: PrismaClient | Prisma.TransactionClient,
    operation: () => Promise<T>,
    options: PrismaTransactionRunOptions,
  ): Promise<T> {
    const active = this.storage.getStore()
    if (active !== undefined) return this.runNested(active, operation)
    if (!('$transaction' in root)) {
      return Promise.reject(new Error('Root Prisma Client is required'))
    }
    return root.$transaction(
      (client) => this.runOuter(client, operation, options.beforeOperation),
      { maxWait: options.maxWait, timeout: options.timeout },
    )
  }

  private async runNested<T>(
    active: ActiveTransaction,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation()
    } catch (error: unknown) {
      active.rollbackOnly = true
      active.rollbackCause ??= error
      throw error
    }
  }

  private runOuter<T>(
    client: Prisma.TransactionClient,
    operation: () => Promise<T>,
    beforeOperation?: (client: Prisma.TransactionClient) => Promise<void>,
  ): Promise<T> {
    const active: ActiveTransaction = { client, rollbackOnly: false }
    return this.storage.run(active, async () => {
      await beforeOperation?.(client)
      const result = await operation()
      if (active.rollbackOnly) {
        throw new DatabaseTransactionRollbackOnlyError(active.rollbackCause)
      }
      return result
    })
  }
}
