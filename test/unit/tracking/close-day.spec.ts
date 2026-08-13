import {
  CLOSE_DAY_PREVIEW_HASH_VERSION,
  CLOSE_DAY_PREVIEW_SCHEMA_VERSION,
  CloseDayAlreadyClosedError,
  CloseDayCommand,
  CloseDayPreviewConflictError,
  CloseDayRevisionConflictError,
  CloseDayTargetUnavailableError,
  PreviewCloseDayQuery,
  TrackingAuthorizationDeniedError,
  closeDayPreviewHash,
  type CloseDayPersistencePort,
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
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'

const memberId = '11111111-1111-4111-8111-111111111111'
const spaceId = '22222222-2222-4222-8222-222222222222'
const publicationId = '33333333-3333-4333-8333-333333333333'
const expectationId = '44444444-4444-4444-8444-444444444444'
const snapshotId = '55555555-5555-4555-8555-555555555555'
const commandId = '66666666-6666-4666-8666-666666666666'
const dayCloseId = '77777777-7777-4777-8777-777777777777'

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
    return effect({ occurredAt: new Date('2026-05-02T01:00:00.123Z') })
  }
}

class ShortCircuitExecutor implements CommandExecutor {
  public constructor(
    private readonly result:
      DurableCommandResultRef<'tracking.day-close.v1'> | Error,
  ) {}

  public execute<TPayload, K extends string>(
    definition: CommandDefinition<TPayload, K>,
  ): Promise<DurableCommandResultRef<K>> {
    void definition
    if (this.result instanceof Error) return Promise.reject(this.result)
    return Promise.resolve(this.result as DurableCommandResultRef<K>)
  }
}

class ImmediateTransaction implements DatabaseTransactionPort {
  public calls = 0

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    this.calls += 1
    return operation()
  }
}

class CountingClock implements ProductClock {
  public calls = 0

  public now(): Date {
    this.calls += 1
    return new Date('2026-05-02T01:00:00.123Z')
  }

  public today(): string {
    throw new Error('unexpected today')
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
  closeError: Error | null = null,
): CloseDayPersistencePort {
  return {
    preview: (input) => {
      inputs.push(input)
      return Promise.resolve({
        state: 'ready',
        factsRevision: 0n,
        unresolved: [
          {
            fixedExpectationId: expectationId,
            planGoalSnapshotId: snapshotId,
            goalTitle: 'Water',
            componentKind: 'goal',
            componentId: null,
            componentLabel: null,
            scope: 'personal',
          },
        ],
      })
    },
    close: (input) => {
      inputs.push(input)
      if (closeError !== null) return Promise.reject(closeError)
      return Promise.resolve({ dayCloseId, factsRevision: 1n })
    },
  }
}

function command(): Parameters<CloseDayCommand['execute']>[0] {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    expectedRevision: 0n,
    payload: {
      publicationId,
      localDate: '2026-05-01',
      previewSchemaVersion: CLOSE_DAY_PREVIEW_SCHEMA_VERSION,
      previewHashVersion: CLOSE_DAY_PREVIEW_HASH_VERSION,
      previewHash: 'a'.repeat(64),
    },
  }
}

describe('T08 CloseDay application contracts', () => {
  it('builds deterministic actor-relative preview and reads the clock once', async () => {
    const inputs: unknown[] = []
    const clock = new CountingClock()
    const transaction = new ImmediateTransaction()
    const query = new PreviewCloseDayQuery(
      members(),
      persistence(inputs),
      transaction,
      clock,
    )
    const result = await query.execute({
      trustedActor: { kind: 'member', id: memberId },
      publicationId,
      localDate: '2026-05-01',
    })
    expect(result).toMatchObject({
      schemaVersion: CLOSE_DAY_PREVIEW_SCHEMA_VERSION,
      state: 'ready',
      factsRevision: 0n,
      previewHashVersion: CLOSE_DAY_PREVIEW_HASH_VERSION,
      unresolved: [{ fixedExpectationId: expectationId }],
    })
    if (result.state !== 'ready') throw new Error('ready preview expected')
    expect(result.previewHash).toBe(
      closeDayPreviewHash({
        publicationId,
        localDate: '2026-05-01',
        memberId,
        factsRevision: 0n,
        unresolved: result.unresolved,
      }),
    )
    expect(clock.calls).toBe(1)
    expect(transaction.calls).toBe(1)
    expect(inputs).toEqual([
      expect.objectContaining({
        spaceId,
        memberId,
        currentLocalDate: '2026-05-02',
      }),
    ])
  })

  it('accepts facts revision zero and forwards the immutable confirmation', async () => {
    const executor = new ImmediateExecutor()
    const inputs: unknown[] = []
    const close = new CloseDayCommand(executor, members(), persistence(inputs))
    await expect(close.execute(command())).resolves.toEqual({
      kind: 'tracking.day-close.v1',
      aggregateId: dayCloseId,
      aggregateRevision: 1n,
    })
    expect(executor.definition).toMatchObject({
      commandType: 'tracking.close-day.v1',
      resultKind: 'tracking.day-close.v1',
    })
    expect(inputs).toEqual([
      expect.objectContaining({
        actorScope: `member:${memberId}`,
        expectedRevision: 0n,
        currentLocalDate: '2026-05-02',
      }),
    ])
  })

  it.each([
    ['missing revision', { ...command(), expectedRevision: undefined }],
    ['negative revision', { ...command(), expectedRevision: -1n }],
    [
      'unknown payload field',
      { ...command(), payload: { ...command().payload, unexpected: true } },
    ],
    [
      'wrong schema',
      {
        ...command(),
        payload: { ...command().payload, previewSchemaVersion: 'wrong' },
      },
    ],
    [
      'invalid hash',
      { ...command(), payload: { ...command().payload, previewHash: 'xyz' } },
    ],
  ])('rejects %s before executor', (_label, value) => {
    const executor = new ImmediateExecutor()
    const close = new CloseDayCommand(executor, members(), persistence())
    expect(() => close.execute(value as never)).toThrow(CommandValidationError)
    expect(executor.calls).toBe(0)
  })

  it.each([
    [
      'replay',
      {
        kind: 'tracking.day-close.v1' as const,
        aggregateId: dayCloseId,
        aggregateRevision: 1n,
      },
    ],
    ['fingerprint conflict', new CommandFingerprintConflictError()],
  ])('short-circuits %s before membership', async (_label, outcome) => {
    let resolved = 0
    const close = new CloseDayCommand(
      new ShortCircuitExecutor(outcome),
      members(() => {
        resolved += 1
      }),
      persistence(),
    )
    const promise = close.execute(command())
    if (outcome instanceof Error) await expect(promise).rejects.toBe(outcome)
    else await expect(promise).resolves.toEqual(outcome)
    expect(resolved).toBe(0)
  })

  it('rejects system actors on preview and confirmation', async () => {
    const system = { kind: 'system' as const, id: 'planner-worker' as const }
    const query = new PreviewCloseDayQuery(
      members(),
      persistence(),
      new ImmediateTransaction(),
      new CountingClock(),
    )
    await expect(
      query.execute({
        trustedActor: system,
        publicationId,
        localDate: '2026-05-01',
      }),
    ).rejects.toBeInstanceOf(TrackingAuthorizationDeniedError)
    const close = new CloseDayCommand(
      new ImmediateExecutor(),
      members(),
      persistence(),
    )
    await expect(
      close.execute({ ...command(), trustedActor: system }),
    ).rejects.toBeInstanceOf(TrackingAuthorizationDeniedError)
  })

  it.each([
    new CloseDayTargetUnavailableError('closed'),
    new CloseDayRevisionConflictError(0n, 1n),
    new CloseDayPreviewConflictError(),
    new CloseDayAlreadyClosedError({ dayCloseId, revision: 1n }),
  ])('preserves finite persistence error %s', async (failure) => {
    const close = new CloseDayCommand(
      new ImmediateExecutor(),
      members(),
      persistence([], failure),
    )
    await expect(close.execute(command())).rejects.toBe(failure)
  })
})
