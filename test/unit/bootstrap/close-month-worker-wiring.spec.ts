import { createPlannerWorkerPlanningDependencies } from '@/bootstrap/planner-worker/configure-planner-worker'
import { composePlannerWorkerTick } from '@/bootstrap/planner-worker/reminder-worker-wiring'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'
import type { CloseMonthReportPort } from '@/modules/planning/application/close-month.command'

describe('planner worker L01 wiring', () => {
  it('injects the reporting close participant into production planning dependencies', () => {
    const database = {} as PrismaClientProvider
    const transaction = {} as DatabaseTransactionPort
    const clock = {} as ProductClock
    const closeMonthReport = {} as CloseMonthReportPort
    expect(
      createPlannerWorkerPlanningDependencies({
        database,
        transaction,
        clock,
        closeMonthReport,
      }),
    ).toEqual({ database, transaction, clock, closeMonthReport })
  })

  it('passes shutdown signal to planning before reminders', async () => {
    const events: string[] = []
    const signal = new AbortController().signal
    const tick = composePlannerWorkerTick(
      {
        tick: (received) => {
          expect(received).toBe(signal)
          events.push('planning')
          return Promise.resolve()
        },
      },
      {
        execute: (received) => {
          expect(received).toBe(signal)
          events.push('reminders')
          return Promise.resolve()
        },
      },
    )

    await tick(signal)
    expect(events).toEqual(['planning', 'reminders'])
  })
})
