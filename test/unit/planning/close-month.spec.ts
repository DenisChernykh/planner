import {
  CloseMonthCommand,
  CloseMonthNoWorkError,
  canonicalCloseMonthPayload,
  createPlanningLifecycleWorker,
  type CloseMonthLifecycleRepositoryPort,
} from '@/modules/planning'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type {
  ApplicationCommand,
  CommandDefinition,
  CommandExecutionContext,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import { CommandValidationError } from '@/shared/application/application-command'

const planMonthId = '11111111-1111-4111-8111-111111111111'
const reportRevisionId = '22222222-2222-4222-8222-222222222222'
const commandId = '33333333-3333-4333-8333-333333333333'

class ImmediateExecutor implements CommandExecutor {
  public definition: CommandDefinition<unknown, string> | undefined

  public execute<TPayload, K extends string>(
    definition: CommandDefinition<TPayload, K>,
    _command: ApplicationCommand<TPayload>,
    effect: (
      context: CommandExecutionContext,
    ) => Promise<DurableCommandResultRef<K>>,
  ): Promise<DurableCommandResultRef<K>> {
    this.definition = definition as CommandDefinition<unknown, string>
    return effect({ occurredAt: new Date('2026-04-04T00:00:00.000Z') })
  }
}

function lifecycle(
  closeInputs: unknown[] = [],
): CloseMonthLifecycleRepositoryPort {
  return {
    findDueMonthClosures: () => Promise.resolve([]),
    transitionDueGrace: () => Promise.resolve(),
    closeMonth: (input) => {
      closeInputs.push(input)
      return Promise.resolve({
        reportRevisionId,
        reportRevision: 1n,
        lifecycleRevision: 4n,
      })
    },
  }
}

function command(): Parameters<CloseMonthCommand['execute']>[0] {
  return {
    commandId,
    trustedActor: { kind: 'system', id: 'planner-worker' },
    payload: { planMonthId },
  }
}

describe('L01 CloseMonth application contract', () => {
  it('uses the exact system command and report revision result', async () => {
    const executor = new ImmediateExecutor()
    const inputs: unknown[] = []
    const closeMonth = new CloseMonthCommand(executor, lifecycle(inputs))

    await expect(closeMonth.execute(command())).resolves.toEqual({
      kind: 'planning.report-revision.v1',
      aggregateId: reportRevisionId,
      aggregateRevision: 1n,
    })
    expect(executor.definition).toMatchObject({
      commandType: 'planning.close-month.v1',
      resultKind: 'planning.report-revision.v1',
    })
    expect(canonicalCloseMonthPayload(command().payload)).toEqual(
      command().payload,
    )
    expect(inputs).toEqual([
      {
        ...command().payload,
        commandId,
        occurredAt: new Date('2026-04-04T00:00:00.000Z'),
        revisionStatus: 'original',
        createdBy: { kind: 'system', id: 'planner-worker' },
      },
    ])
  })

  it.each([
    { ...command(), expectedRevision: 0n },
    { ...command(), unknown: true },
    { ...command(), trustedActor: { kind: 'member', id: commandId } },
    { ...command(), payload: { ...command().payload, unknown: true } },
    { ...command(), payload: { planMonthId: 'not-a-uuid' } },
  ])('rejects non-exact command %#', async (input) => {
    const executor = new ImmediateExecutor()
    const closeMonth = new CloseMonthCommand(executor, lifecycle())
    await expect(closeMonth.execute(input as never)).rejects.toBeInstanceOf(
      CommandValidationError,
    )
  })

  it('preserves the finite no-work result', async () => {
    const noWork = new CloseMonthNoWorkError()
    const port: CloseMonthLifecycleRepositoryPort = {
      findDueMonthClosures: () => Promise.resolve([]),
      transitionDueGrace: () => Promise.resolve(),
      closeMonth: () => Promise.reject(noWork),
    }
    await expect(
      new CloseMonthCommand(new ImmediateExecutor(), port).execute(command()),
    ).rejects.toBe(noWork)
  })
})

describe('L01 lifecycle worker', () => {
  it('starts grace before closing deterministic due months', async () => {
    const events: unknown[] = []
    const port: CloseMonthLifecycleRepositoryPort = {
      transitionDueGrace: (input) => {
        events.push(['grace', input])
        return Promise.resolve()
      },
      findDueMonthClosures: (input) => {
        events.push(['scan', input])
        return Promise.resolve([
          { commandId, planMonthId },
          { commandId: reportRevisionId, planMonthId: reportRevisionId },
        ])
      },
      closeMonth: () => Promise.reject(new Error('unexpected direct close')),
    }
    const closeMonth = {
      execute: (input: unknown) => {
        events.push(['close', input])
        return Promise.resolve({
          kind: 'planning.report-revision.v1' as const,
          aggregateId: reportRevisionId,
          aggregateRevision: 4n,
        })
      },
    }
    const clock = new FakeProductClock(new Date('2026-04-04T00:00:00.000Z'))
    const worker = createPlanningLifecycleWorker({
      database: {} as PrismaClientProvider,
      transaction: {} as DatabaseTransactionPort,
      lifecycle: port,
      closeMonth,
      clock,
    })

    await worker.tick()
    expect(events[0]).toEqual([
      'grace',
      {
        currentLocalDate: '2026-04-04',
        limit: 100,
        occurredAt: new Date('2026-04-04T00:00:00.000Z'),
      },
    ])
    expect(events[1]).toEqual([
      'scan',
      { currentLocalDate: '2026-04-04', limit: 100 },
    ])
    expect(events.slice(2)).toHaveLength(2)
  })

  it('drains weekly backlog before starting monthly lifecycle work', async () => {
    const weeklyGroups = [
      {
        commandId,
        publicationId: planMonthId,
        periodStart: '2026-03-01',
        periodEnd: '2026-03-07',
      },
      {
        commandId: reportRevisionId,
        publicationId: planMonthId,
        periodStart: '2026-03-08',
        periodEnd: '2026-03-14',
      },
    ]
    const calls: string[] = []
    const lifecycle = {
      findDueWeekGroups: () => {
        const next = weeklyGroups.shift()
        return Promise.resolve(next === undefined ? [] : [next])
      },
      closeWeek: () => {
        calls.push('week')
        return Promise.resolve({
          actionId: reportRevisionId,
          factsRevision: 1n,
        })
      },
      transitionDueGrace: () => {
        calls.push('grace')
        return Promise.resolve()
      },
      findDueMonthClosures: () => Promise.resolve([]),
    }
    const worker = createPlanningLifecycleWorker({
      database: {} as PrismaClientProvider,
      transaction: {} as DatabaseTransactionPort,
      lifecycle,
      closeWeek: {
        execute: () => {
          calls.push('week')
          return Promise.resolve({
            kind: 'planning.week-close.v1' as const,
            aggregateId: reportRevisionId,
            aggregateRevision: 1n,
          })
        },
      },
      clock: new FakeProductClock(new Date('2026-04-04T00:00:00.000Z')),
      batchLimit: 1,
    })

    await worker.tick()
    expect(calls).toEqual(['week', 'week', 'grace'])
  })
})
