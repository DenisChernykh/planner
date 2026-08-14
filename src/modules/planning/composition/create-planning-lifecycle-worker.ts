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
import { PrismaDueLifecycleRepository } from '../infrastructure/due-lifecycle.repository'

export interface PlanningLifecycleWorker {
  tick(): Promise<void>
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
  readonly lifecycle?: DueLifecycleRepositoryPort
  readonly closeWeek?: Pick<CloseWeekCommand, 'execute'>
  readonly batchLimit?: number
}): PlanningLifecycleWorker {
  const lifecycle =
    dependencies.lifecycle ??
    new PrismaDueLifecycleRepository(dependencies.database)
  const receipts = new PrismaCommandReceiptAdapter(dependencies.database)
  const batchLimit = dependencies.batchLimit ?? 100
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 100) {
    throw new RangeError('Planner worker batch limit is invalid')
  }
  return Object.freeze({
    tick: async () => {
      const now = dependencies.clock.now()
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new Error('Planner worker clock is invalid')
      }
      const closeWeek =
        dependencies.closeWeek ??
        new CloseWeekCommand(
          new DurableCommandExecutor(
            dependencies.transaction,
            receipts,
            clockAt(now),
          ),
          lifecycle,
        )
      const due = await lifecycle.findDueWeekGroups({
        currentLocalDate: localDateAt(now),
        limit: batchLimit,
      })
      for (const group of due) {
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
        }
      }
    },
  })
}
