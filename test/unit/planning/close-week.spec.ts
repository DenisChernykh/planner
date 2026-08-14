import {
  CloseWeekCommand,
  CloseWeekNoWorkError,
  canonicalCloseWeekPayload,
  createPlanningLifecycleWorker,
  type DueLifecycleRepositoryPort,
} from '@/modules/planning'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import type {
  ApplicationCommand,
  CommandDefinition,
  CommandExecutionContext,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import { CommandValidationError } from '@/shared/application/application-command'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'

const publicationId = '11111111-1111-4111-8111-111111111111'
const commandId = '22222222-2222-4222-8222-222222222222'
const actionId = '33333333-3333-4333-8333-333333333333'

class ImmediateExecutor implements CommandExecutor {
  public calls = 0
  public definition: CommandDefinition<unknown, string> | undefined

  public execute<TPayload, K extends string>(
    definition: CommandDefinition<TPayload, K>,
    _command: ApplicationCommand<TPayload>,
    effect: (
      context: CommandExecutionContext,
    ) => Promise<DurableCommandResultRef<K>>,
  ): Promise<DurableCommandResultRef<K>> {
    this.calls += 1
    this.definition = definition as CommandDefinition<unknown, string>
    return effect({ occurredAt: new Date('2026-04-13T19:00:00.000Z') })
  }
}

function lifecycle(inputs: unknown[] = []): DueLifecycleRepositoryPort {
  return {
    findDueWeekGroups: () => Promise.resolve([]),
    closeWeek: (input) => {
      inputs.push(input)
      return Promise.resolve({ actionId, factsRevision: 7n })
    },
  }
}

function command(): Parameters<CloseWeekCommand['execute']>[0] {
  return {
    commandId,
    trustedActor: { kind: 'system', id: 'planner-worker' },
    payload: {
      publicationId,
      periodStart: '2026-04-06',
      periodEnd: '2026-04-12',
    },
  }
}

describe('T10 CloseWeek application contract', () => {
  it('uses the exact canonical payload and system result contract', async () => {
    const executor = new ImmediateExecutor()
    const inputs: unknown[] = []
    const closeWeek = new CloseWeekCommand(executor, lifecycle(inputs))
    await expect(closeWeek.execute(command())).resolves.toEqual({
      kind: 'planning.week-close.v1',
      aggregateId: actionId,
      aggregateRevision: 7n,
    })
    expect(executor.definition).toMatchObject({
      commandType: 'planning.close-week.v1',
      resultKind: 'planning.week-close.v1',
    })
    expect(canonicalCloseWeekPayload(command().payload)).toEqual(
      command().payload,
    )
    expect(inputs).toEqual([
      {
        ...command().payload,
        commandId,
        occurredAt: new Date('2026-04-13T19:00:00.000Z'),
      },
    ])
  })

  it.each([
    { ...command(), expectedRevision: 0n },
    { ...command(), unknown: true },
    { ...command(), trustedActor: { kind: 'member', id: commandId } },
    { ...command(), payload: { ...command().payload, unknown: true } },
    {
      ...command(),
      payload: { ...command().payload, periodStart: '2026-04-31' },
    },
    {
      ...command(),
      payload: {
        ...command().payload,
        periodStart: '2026-04-13',
        periodEnd: '2026-04-12',
      },
    },
  ])('rejects non-exact command %#', async (input) => {
    const executor = new ImmediateExecutor()
    const closeWeek = new CloseWeekCommand(executor, lifecycle())
    await expect(closeWeek.execute(input as never)).rejects.toBeInstanceOf(
      CommandValidationError,
    )
    expect(executor.calls).toBe(0)
  })

  it('preserves the finite no-work result', async () => {
    const noWork = new CloseWeekNoWorkError()
    const port: DueLifecycleRepositoryPort = {
      findDueWeekGroups: () => Promise.resolve([]),
      closeWeek: () => Promise.reject(noWork),
    }
    await expect(
      new CloseWeekCommand(new ImmediateExecutor(), port).execute(command()),
    ).rejects.toBe(noWork)
  })
})

describe('T10 due lifecycle tick', () => {
  it('reads the clock once and closes deterministic due groups in order', async () => {
    const events: unknown[] = []
    const port: DueLifecycleRepositoryPort = {
      findDueWeekGroups: (input) => {
        events.push(['scan', input])
        return Promise.resolve([
          {
            commandId,
            publicationId,
            periodStart: '2026-04-06',
            periodEnd: '2026-04-12',
          },
          {
            commandId: actionId,
            publicationId,
            periodStart: '2026-04-13',
            periodEnd: '2026-04-19',
          },
        ])
      },
      closeWeek: () => Promise.reject(new Error('unexpected direct close')),
    }
    const fakeClose = {
      execute: (input: unknown) => {
        events.push(['close', input])
        return Promise.resolve({
          kind: 'planning.week-close.v1' as const,
          aggregateId: actionId,
          aggregateRevision: 1n,
        })
      },
    }
    const clock = new FakeProductClock(new Date('2026-04-20T01:00:00.000Z'))
    let reads = 0
    const worker = createPlanningLifecycleWorker({
      database: {} as PrismaClientProvider,
      transaction: {} as DatabaseTransactionPort,
      lifecycle: port,
      closeWeek: fakeClose,
      clock: {
        now: () => {
          reads += 1
          return clock.now()
        },
        today: (zone) => clock.today(zone),
      },
    })
    await worker.tick()
    expect(reads).toBe(1)
    expect(events[0]).toEqual([
      'scan',
      { currentLocalDate: '2026-04-20', limit: 100 },
    ])
    expect(events.slice(1)).toHaveLength(2)
  })
})
