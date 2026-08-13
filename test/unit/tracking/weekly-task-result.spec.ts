import {
  FactCorrectionRequiredError,
  RecordWeeklyTaskResultCommand,
  TrackingAuthorizationDeniedError,
  WeeklyTaskAlreadySystemClosedError,
  WeeklyTaskTargetUnavailableError,
  type WeeklyTaskResultPersistencePort,
} from '@/modules/tracking'
import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type {
  ApplicationCommand,
  CommandDefinition,
  CommandExecutionContext,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import {
  CommandFingerprintConflictError,
  CommandValidationError,
} from '@/shared/application/application-command'

const memberId = '11111111-1111-4111-8111-111111111111'
const spaceId = '22222222-2222-4222-8222-222222222222'
const publicationId = '33333333-3333-4333-8333-333333333333'
const flexiblePeriodId = '44444444-4444-4444-8444-444444444444'
const factRecordId = '55555555-5555-4555-8555-555555555555'
const commandId = '66666666-6666-4666-8666-666666666666'

class ImmediateExecutor implements CommandExecutor {
  public calls = 0
  public definition: CommandDefinition<unknown, string> | undefined

  public async execute<TPayload, K extends string>(
    definition: CommandDefinition<TPayload, K>,
    _command: ApplicationCommand<TPayload>,
    effect: (
      context: CommandExecutionContext,
    ) => Promise<DurableCommandResultRef<K>>,
  ): Promise<DurableCommandResultRef<K>> {
    this.calls += 1
    this.definition = definition as CommandDefinition<unknown, string>
    return effect({ occurredAt: new Date('2026-04-15T07:00:00.123Z') })
  }
}

class ShortCircuitExecutor implements CommandExecutor {
  public constructor(
    private readonly result:
      DurableCommandResultRef<'tracking.fact-record.v1'> | Error,
  ) {}

  public execute<TPayload, K extends string>(
    _definition: CommandDefinition<TPayload, K>,
    _command: ApplicationCommand<TPayload>,
    _effect: (
      context: CommandExecutionContext,
    ) => Promise<DurableCommandResultRef<K>>,
  ): Promise<DurableCommandResultRef<K>> {
    void _definition
    void _command
    void _effect
    if (this.result instanceof Error) return Promise.reject(this.result)
    return Promise.resolve(this.result as DurableCommandResultRef<K>)
  }
}

function members(
  onResolve: () => void = () => undefined,
): WorkspaceMemberResolver {
  return {
    resolveUser: () => Promise.reject(new Error('unexpected resolveUser')),
    resolveTelegramId: () =>
      Promise.reject(new Error('unexpected resolveTelegramId')),
    resolveMember: () => {
      onResolve()
      return Promise.resolve({ spaceId, memberId, userId: memberId })
    },
  }
}

function persistence(
  inputs: unknown[] = [],
  failure: Error | null = null,
): WeeklyTaskResultPersistencePort {
  return {
    record: (input) => {
      inputs.push(input)
      if (failure !== null) return Promise.reject(failure)
      return Promise.resolve({ factRecordId, factRevision: 1n })
    },
  }
}

function command(): Parameters<RecordWeeklyTaskResultCommand['execute']>[0] {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    payload: { publicationId, flexiblePeriodId, result: 'done' },
  }
}

describe('T09 weekly planned task result contracts', () => {
  it('canonicalizes the exact payload and forwards trusted member context', async () => {
    const executor = new ImmediateExecutor()
    const inputs: unknown[] = []
    const record = new RecordWeeklyTaskResultCommand(
      executor,
      members(),
      persistence(inputs),
    )
    await expect(record.execute(command())).resolves.toEqual({
      kind: 'tracking.fact-record.v1',
      aggregateId: factRecordId,
      aggregateRevision: 1n,
    })
    expect(executor.definition).toMatchObject({
      commandType: 'tracking.record-weekly-task-result.v1',
      resultKind: 'tracking.fact-record.v1',
    })
    expect(executor.definition?.toCanonicalPayload(command().payload)).toEqual(
      command().payload,
    )
    expect(inputs).toEqual([
      expect.objectContaining({
        actorScope: `member:${memberId}`,
        currentLocalDate: '2026-04-15',
        result: 'done',
      }),
    ])
  })

  it.each([
    ['expectedRevision', { ...command(), expectedRevision: 1n }],
    ['unknown command field', { ...command(), unknown: true }],
    [
      'unknown payload field',
      { ...command(), payload: { ...command().payload, unknown: true } },
    ],
    [
      'invalid result',
      { ...command(), payload: { ...command().payload, result: 'partial' } },
    ],
  ])('rejects %s before executor', async (_label, input) => {
    const executor = new ImmediateExecutor()
    const record = new RecordWeeklyTaskResultCommand(
      executor,
      members(),
      persistence(),
    )
    await expect(record.execute(input as never)).rejects.toBeInstanceOf(
      CommandValidationError,
    )
    expect(executor.calls).toBe(0)
  })

  it.each([
    [
      'replay',
      {
        kind: 'tracking.fact-record.v1' as const,
        aggregateId: factRecordId,
        aggregateRevision: 1n,
      },
    ],
    ['fingerprint conflict', new CommandFingerprintConflictError()],
  ])('short-circuits %s before membership', async (_label, outcome) => {
    let resolved = 0
    const record = new RecordWeeklyTaskResultCommand(
      new ShortCircuitExecutor(outcome),
      members(() => {
        resolved += 1
      }),
      persistence(),
    )
    const promise = record.execute(command())
    if (outcome instanceof Error) await expect(promise).rejects.toBe(outcome)
    else await expect(promise).resolves.toEqual(outcome)
    expect(resolved).toBe(0)
  })

  it('rejects system actor before persistence', async () => {
    const inputs: unknown[] = []
    const record = new RecordWeeklyTaskResultCommand(
      new ImmediateExecutor(),
      members(),
      persistence(inputs),
    )
    await expect(
      record.execute({
        ...command(),
        trustedActor: { kind: 'system', id: 'planner-worker' },
      }),
    ).rejects.toBeInstanceOf(TrackingAuthorizationDeniedError)
    expect(inputs).toEqual([])
  })

  it.each([
    new WeeklyTaskTargetUnavailableError('stale_period'),
    new FactCorrectionRequiredError({ factRecordId, revision: 1n }),
    new WeeklyTaskAlreadySystemClosedError({ factRecordId, revision: 1n }),
  ])('preserves finite persistence error %s', async (failure) => {
    const record = new RecordWeeklyTaskResultCommand(
      new ImmediateExecutor(),
      members(),
      persistence([], failure),
    )
    await expect(record.execute(command())).rejects.toBe(failure)
  })
})
