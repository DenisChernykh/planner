import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'
import type { ProductClock } from '@/shared/application/product-clock'

import {
  CloseWeekCommand,
  CloseWeekNoWorkError,
} from '../application/close-week.command'
import type { DueLifecycleRepositoryPort } from '../application/close-week.command'
import {
  CloseMonthCommand,
  CloseMonthNoWorkError,
} from '../application/close-month.command'
import type {
  CloseMonthLifecycleRepositoryPort,
  CloseMonthReportPort,
} from '../application/close-month.command'
import {
  StartMonthGraceCommand,
  StartMonthGraceNoWorkError,
} from '../application/start-month-grace.command'
import { PrismaDueLifecycleRepository } from '../infrastructure/due-lifecycle.repository'

export interface PlanningLifecycleWorker {
  tick(signal?: AbortSignal): Promise<void>
}

const MAX_WEEKLY_BATCHES_PER_TICK = 10

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Planner worker tick aborted')
}

function localDateAt(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yekaterinburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value)
}

function clockAt(value: Date): ProductClock {
  const epoch = value.getTime()
  return Object.freeze({
    now: () => new Date(epoch),
    today: (timeZone: 'Asia/Yekaterinburg') => {
      if (timeZone !== 'Asia/Yekaterinburg') {
        throw new RangeError('Planner worker time zone is invalid')
      }
      return localDateAt(new Date(epoch))
    },
  })
}

export function createPlanningLifecycleWorker(dependencies: {
  readonly database: PrismaClientProvider
  readonly transaction: DatabaseTransactionPort
  readonly clock: ProductClock
  readonly lifecycle?: Partial<
    DueLifecycleRepositoryPort & CloseMonthLifecycleRepositoryPort
  >
  readonly closeWeek?: Pick<CloseWeekCommand, 'execute'>
  readonly startMonthGrace?: Pick<StartMonthGraceCommand, 'execute'>
  readonly closeMonth?: Pick<CloseMonthCommand, 'execute'>
  readonly closeMonthReport?: CloseMonthReportPort
  readonly batchLimit?: number
}): PlanningLifecycleWorker {
  const lifecycle: Partial<
    DueLifecycleRepositoryPort & CloseMonthLifecycleRepositoryPort
  > =
    dependencies.lifecycle ??
    new PrismaDueLifecycleRepository(dependencies.database)
  const receipts = new PrismaCommandReceiptAdapter(dependencies.database)
  const batchLimit = dependencies.batchLimit ?? 100
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 100) {
    throw new RangeError('Planner worker batch limit is invalid')
  }
  return Object.freeze({
    tick: async (signal?: AbortSignal) => {
      const now = dependencies.clock.now()
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new Error('Planner worker clock is invalid')
      }
      if (
        lifecycle.findDueWeekGroups !== undefined &&
        lifecycle.closeWeek !== undefined
      ) {
        const closeWeek =
          dependencies.closeWeek ??
          new CloseWeekCommand(
            new DurableCommandExecutor(
              dependencies.transaction,
              receipts,
              clockAt(now),
            ),
            lifecycle as DueLifecycleRepositoryPort,
          )
        for (let batch = 0; batch < MAX_WEEKLY_BATCHES_PER_TICK; batch += 1) {
          throwIfAborted(signal)
          const due = await lifecycle.findDueWeekGroups({
            currentLocalDate: localDateAt(now),
            limit: batchLimit,
          })
          if (due.length === 0) break
          let noWorkInBatch = false
          for (const group of due) {
            throwIfAborted(signal)
            try {
              await closeWeek.execute({
                commandId: group.commandId,
                trustedActor: { kind: 'system', id: 'planner-worker' },
                payload: {
                  publicationId: group.publicationId,
                  periodStart: group.periodStart,
                  periodEnd: group.periodEnd,
                },
              })
            } catch (error: unknown) {
              if (!(error instanceof CloseWeekNoWorkError)) throw error
              noWorkInBatch = true
            }
          }
          if (noWorkInBatch || due.length < batchLimit) break
        }
      }
      throwIfAborted(signal)
      const lifecycleMonth = lifecycle
      if (
        lifecycleMonth?.findDueMonthClosures === undefined ||
        (lifecycleMonth.findDueMonthGrace === undefined &&
          lifecycleMonth.transitionDueGrace === undefined)
      ) {
        return
      }
      if (
        lifecycleMonth.findDueMonthGrace !== undefined &&
        lifecycleMonth.startMonthGrace !== undefined
      ) {
        const startGrace =
          dependencies.startMonthGrace ??
          new StartMonthGraceCommand(
            new DurableCommandExecutor(
              dependencies.transaction,
              receipts,
              clockAt(now),
            ),
            lifecycleMonth as CloseMonthLifecycleRepositoryPort,
          )
        const dueGrace = await lifecycleMonth.findDueMonthGrace({
          currentLocalDate: localDateAt(now),
          limit: batchLimit,
        })
        for (const month of dueGrace) {
          throwIfAborted(signal)
          try {
            await startGrace.execute({
              commandId: month.commandId,
              trustedActor: { kind: 'system', id: 'planner-worker' },
              payload: {
                planMonthId: month.planMonthId,
              },
              expectedRevision: BigInt(month.expectedRevision),
            })
          } catch (error: unknown) {
            if (!(error instanceof StartMonthGraceNoWorkError)) throw error
          }
        }
      } else {
        await lifecycleMonth.transitionDueGrace!({
          currentLocalDate: localDateAt(now),
          limit: batchLimit,
          occurredAt: now,
        })
      }
      const dueMonths = await lifecycleMonth.findDueMonthClosures({
        currentLocalDate: localDateAt(now),
        limit: batchLimit,
      })
      const closeMonth =
        dependencies.closeMonth ??
        (dependencies.closeMonthReport === undefined
          ? undefined
          : new CloseMonthCommand(
              new DurableCommandExecutor(
                dependencies.transaction,
                receipts,
                clockAt(now),
              ),
              lifecycleMonth as CloseMonthLifecycleRepositoryPort,
              dependencies.closeMonthReport,
            ))
      if (closeMonth === undefined && dueMonths.length > 0) {
        throw new Error('Planner worker CloseMonth application is incomplete')
      }
      for (const month of dueMonths) {
        throwIfAborted(signal)
        try {
          await closeMonth!.execute({
            commandId: month.commandId,
            trustedActor: { kind: 'system', id: 'planner-worker' },
            payload: { planMonthId: month.planMonthId },
          })
        } catch (error: unknown) {
          if (!(error instanceof CloseMonthNoWorkError)) throw error
        }
      }
    },
  })
}
