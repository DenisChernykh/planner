import { Inject, Injectable, Optional } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

import { PrismaClient, type Prisma } from '@/generated/prisma/client'
import type { DatabaseRuntimeConfig } from '@/platform/config/runtime-config.types'

import { runBoundedPostgresQuery } from './bounded-postgres-query'
import { DatabaseUnavailableError } from './database.contracts'
import { DATABASE_RUNTIME_CONFIG } from './database.tokens'
import { PrismaTransactionContext } from './prisma-transaction.context'

type DatabaseState = 'idle' | 'connected' | 'closing' | 'closed'

@Injectable()
export class PrismaClientProvider {
  private readonly pool: Pool
  private readonly prisma: PrismaClient
  private readonly transactionContext: PrismaTransactionContext
  private readonly activeOperations = new Set<Promise<unknown>>()
  private readonly poolErrorHandler = (): void => {
    this.degraded = true
  }
  private state: DatabaseState = 'idle'
  private degraded = false
  private poolErrorListenerInstalled = true
  private closePromise: Promise<void> | undefined

  public constructor(
    @Inject(DATABASE_RUNTIME_CONFIG)
    private readonly config: { readonly database: DatabaseRuntimeConfig },
    @Inject(PrismaTransactionContext)
    @Optional()
    transactionContext?: PrismaTransactionContext,
  ) {
    this.transactionContext =
      transactionContext ?? new PrismaTransactionContext()
    this.pool = new Pool({
      connectionString: config.database.url,
      max: config.database.poolMax,
      connectionTimeoutMillis: config.database.connectionTimeoutMs,
      idleTimeoutMillis: config.database.idleTimeoutMs,
    })
    this.pool.on('error', this.poolErrorHandler)
    this.prisma = new PrismaClient({
      adapter: new PrismaPg(this.pool, { disposeExternalPool: false }),
    })
  }

  public async connect(signal: AbortSignal): Promise<void> {
    if (this.state === 'connected') return
    if (this.state !== 'idle') throw new DatabaseUnavailableError()
    try {
      await Promise.race([
        this.prisma.$connect(),
        new Promise<never>((_resolve, reject) => {
          const abort = (): void => reject(new DatabaseUnavailableError())
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        }),
      ])
      this.state = 'connected'
      if (
        (await this.checkReadiness(
          signal,
          this.config.database.connectionTimeoutMs,
        )) !== 'up'
      ) {
        throw new DatabaseUnavailableError()
      }
    } catch {
      await this.cleanupResources().catch(() => undefined)
      throw new DatabaseUnavailableError()
    }
  }

  public checkReadiness(
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<'up' | 'down'> {
    if (this.state !== 'connected') return Promise.resolve('down')
    if (this.degraded) {
      this.degraded = false
      return Promise.resolve('down')
    }
    return this.runReadinessQuery(signal, timeoutMs)
  }

  public withClient<T>(
    operation: (client: PrismaClient | Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (this.state !== 'connected') {
      return Promise.reject(new DatabaseUnavailableError())
    }
    const result = Promise.resolve(
      this.transactionContext.withClient(this.prisma, operation),
    )
    this.activeOperations.add(result)
    void result.then(
      () => this.activeOperations.delete(result),
      () => this.activeOperations.delete(result),
    )
    return result
  }

  public close(signal: AbortSignal): Promise<void> {
    this.closePromise ??= this.closeInternal(signal)
    return this.closePromise
  }

  private async closeInternal(signal: AbortSignal): Promise<void> {
    if (this.state === 'closed') return
    this.state = 'closing'
    const settlement = Promise.allSettled([...this.activeOperations])
    await Promise.race([
      settlement,
      new Promise<never>((_resolve, reject) => {
        const abort = (): void => reject(new DatabaseUnavailableError())
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      }),
    ])
    await this.cleanupResources()
  }

  private async runReadinessQuery(
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<'up' | 'down'> {
    const status = await runBoundedPostgresQuery(
      this.pool,
      'SELECT 1',
      signal,
      timeoutMs,
    )
    this.degraded = status !== 'up'
    return status
  }

  private async cleanupResources(): Promise<void> {
    const results = await Promise.allSettled([
      this.prisma.$disconnect(),
      this.pool.end(),
    ])
    if (this.poolErrorListenerInstalled) {
      this.pool.off('error', this.poolErrorHandler)
      this.poolErrorListenerInstalled = false
    }
    this.state = 'closed'
    const failures: unknown[] = []
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason as unknown)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Database cleanup failed')
    }
  }
}
