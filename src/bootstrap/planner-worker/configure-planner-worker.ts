import { createPlanningLifecycleWorker } from '@/modules/planning'
import { createReportingApplication } from '@/modules/reporting'
import { createTrackingApplication } from '@/modules/tracking'
import { createRemindersApplication } from '@/modules/reminders'
import { createWorkspaceMemberResolver } from '@/modules/workspace'
import { createTelegramOutboundTransport } from '@/modules/telegram-bot'
import type { PlannerWorkerRuntimeConfig } from '@/platform/config/planner-worker-runtime-config'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { PeriodicMaintenanceRunner } from '@/platform/maintenance/periodic-maintenance-runner'
import { SystemProductClock } from '@/platform/time/system-product-clock'
import { composePlannerWorkerTick } from './reminder-worker-wiring'

import type { ObservabilityRuntime } from '@/platform/observability/observability.runtime'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'

type CloseMonthReportParticipant = NonNullable<
  Parameters<typeof createPlanningLifecycleWorker>[0]['closeMonthReport']
>

export interface ConfiguredPlannerWorker {
  readonly application: { close(): Promise<void> }
  readonly failure: Promise<void>
}

export class PlannerWorkerStartupCleanupError extends AggregateError {
  public constructor(startupError: unknown, cleanupErrors: readonly unknown[]) {
    super(
      [startupError, ...cleanupErrors],
      'Planner worker startup cleanup failed',
    )
    this.name = 'PlannerWorkerStartupCleanupError'
  }
}

export function createPlannerWorkerPlanningDependencies(input: {
  readonly database: PrismaClientProvider
  readonly transaction: DatabaseTransactionPort
  readonly clock: ProductClock
  readonly closeMonthReport: CloseMonthReportParticipant
}): {
  readonly database: PrismaClientProvider
  readonly transaction: DatabaseTransactionPort
  readonly clock: ProductClock
  readonly closeMonthReport: CloseMonthReportParticipant
} {
  return Object.freeze({
    database: input.database,
    transaction: input.transaction,
    clock: input.clock,
    closeMonthReport: input.closeMonthReport,
  })
}

function startupAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Planner worker startup aborted')
}

export async function configurePlannerWorker(
  config: PlannerWorkerRuntimeConfig,
  observability: ObservabilityRuntime,
  startupSignal: AbortSignal,
): Promise<ConfiguredPlannerWorker> {
  const transactionContext = new PrismaTransactionContext()
  const databaseConfig = { database: config.database }
  const database = new PrismaClientProvider(databaseConfig, transactionContext)
  const transaction = new PrismaTransactionAdapter(
    database,
    transactionContext,
    databaseConfig,
  )
  const clock = new SystemProductClock()
  const workspaceMembers = createWorkspaceMemberResolver(database)
  const reporting = createReportingApplication({
    database,
    transaction,
    workspaceMembers,
    clock,
  })
  const worker = createPlanningLifecycleWorker(
    createPlannerWorkerPlanningDependencies({
      database,
      transaction,
      clock,
      closeMonthReport: reporting.buildCloseMonthReport,
    }),
  )
  const tracking = createTrackingApplication({
    database,
    transaction,
    workspaceMembers,
    clock,
  })
  const reminders = createRemindersApplication({
    database,
    transaction,
    workspaceMembers,
    clock,
    today: {
      getToday: (memberId) =>
        tracking.getToday.execute({
          trustedActor: { kind: 'member', id: memberId },
        }),
    },
    telegramRecipientResolver: workspaceMembers,
    deliveryTransport: createTelegramOutboundTransport(
      config.telegramBot.token,
      config.telegramBot,
    ),
  })
  const reminderCycle = reminders.runDueReminders
  if (reminderCycle === undefined) {
    throw new Error('Planner worker reminders application is incomplete')
  }
  const tick = composePlannerWorkerTick(worker, reminderCycle)
  let runnerController: AbortController | undefined
  try {
    await database.connect(startupSignal)
    if (startupSignal.aborted) throw startupAbortError(startupSignal)
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(startupAbortError(startupSignal))
      startupSignal.addEventListener('abort', onAbort, { once: true })
      void tick(startupSignal)
        .then(resolve, reject)
        .finally(() => startupSignal.removeEventListener('abort', onAbort))
    })
    runnerController = new AbortController()
    const runner = new PeriodicMaintenanceRunner(tick, {
      delayMs: config.intervalMs,
      shutdownGraceMs: config.runnerShutdownGraceMs,
      runOnStart: false,
    })
    let closing = false
    const running = runner.run(runnerController.signal)
    const failure = running.then(() => {
      if (!closing) throw new Error('Planner worker stopped unexpectedly')
      return new Promise<void>(() => undefined)
    })
    let closePromise: Promise<void> | undefined
    return {
      failure,
      application: {
        close: () => {
          closePromise ??= (async () => {
            closing = true
            runnerController?.abort()
            await running.catch(() => undefined)
            const signal = AbortSignal.timeout(config.shutdownGraceMs)
            const results = await Promise.allSettled([
              database.close(signal),
              observability.close(signal),
            ])
            const failures = results.flatMap((result) =>
              result.status === 'rejected' ? [result.reason as unknown] : [],
            )
            if (failures.length > 0) {
              throw new AggregateError(
                failures,
                'Planner worker cleanup failed',
              )
            }
          })()
          return closePromise
        },
      },
    }
  } catch (error: unknown) {
    runnerController?.abort()
    const signal = AbortSignal.timeout(config.shutdownGraceMs)
    const results = await Promise.allSettled([
      database.close(signal),
      observability.close(signal),
    ])
    const cleanupErrors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    )
    if (cleanupErrors.length > 0) {
      throw new PlannerWorkerStartupCleanupError(error, cleanupErrors)
    }
    throw error
  }
}
