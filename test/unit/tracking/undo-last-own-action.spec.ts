import {
  FactUndoUnavailableError,
  TrackingAuthorizationDeniedError,
  UndoLastOwnActionCommand,
  type FactPersistencePort,
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
const factRecordId = '33333333-3333-4333-8333-333333333333'
const commandId = '44444444-4444-4444-8444-444444444444'

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
    private readonly outcome:
      DurableCommandResultRef<'tracking.fact-record.v1'> | Error,
  ) {}

  public execute<TPayload, K extends string>(
    definition: CommandDefinition<TPayload, K>,
  ): Promise<DurableCommandResultRef<K>> {
    void definition
    if (this.outcome instanceof Error) return Promise.reject(this.outcome)
    return Promise.resolve(this.outcome as DurableCommandResultRef<K>)
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

function facts(
  inputs: unknown[] = [],
  outcome: Error | null = null,
): FactPersistencePort {
  return {
    record: () => Promise.reject(new Error('unexpected record')),
    mutate: () => Promise.reject(new Error('unexpected mutate')),
    undoLastOwnAction: (input) => {
      inputs.push(input)
      if (outcome !== null) return Promise.reject(outcome)
      return Promise.resolve({ factRecordId, factRevision: 2n })
    },
    getState: () => Promise.reject(new Error('unexpected getState')),
    getGoalProgressInput: () =>
      Promise.reject(new Error('unexpected getGoalProgressInput')),
  }
}

function undo(): Parameters<UndoLastOwnActionCommand['execute']>[0] {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    expectedRevision: 1n,
    payload: { factRecordId },
  }
}

describe('T06 undo-last-own-action application boundary', () => {
  it('snapshots exact payload and forwards trusted member context', async () => {
    const executor = new ImmediateExecutor()
    const inputs: unknown[] = []
    const command = new UndoLastOwnActionCommand(
      executor,
      members(),
      facts(inputs),
    )
    await expect(command.execute(undo())).resolves.toEqual({
      kind: 'tracking.fact-record.v1',
      aggregateId: factRecordId,
      aggregateRevision: 2n,
    })
    expect(executor.definition).toMatchObject({
      commandType: 'tracking.undo-last-own-action.v1',
      resultKind: 'tracking.fact-record.v1',
    })
    expect(inputs).toEqual([
      expect.objectContaining({
        actorScope: `member:${memberId}`,
        memberId,
        spaceId,
        factRecordId,
        expectedRevision: 1n,
        currentLocalDate: '2026-05-02',
      }),
    ])
  })

  it.each([
    ['missing revision', { ...undo(), expectedRevision: undefined }],
    ['zero revision', { ...undo(), expectedRevision: 0n }],
    [
      'extra payload key',
      { ...undo(), payload: { factRecordId, extra: true } },
    ],
    [
      'foreign prototype',
      {
        ...undo(),
        payload: new (class ForeignPayload {
          public readonly factRecordId = factRecordId
        })(),
      },
    ],
  ])('rejects %s before executor', (_label, input) => {
    const executor = new ImmediateExecutor()
    const command = new UndoLastOwnActionCommand(executor, members(), facts())
    expect(() => command.execute(input as never)).toThrow(
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
        aggregateRevision: 2n,
      },
    ],
    ['fingerprint conflict', new CommandFingerprintConflictError()],
  ])(
    'short-circuits %s before membership and persistence',
    async (_label, outcome) => {
      let resolved = 0
      const command = new UndoLastOwnActionCommand(
        new ShortCircuitExecutor(outcome),
        members(() => {
          resolved += 1
        }),
        facts(),
      )
      const promise = command.execute(undo())
      if (outcome instanceof Error) await expect(promise).rejects.toBe(outcome)
      else await expect(promise).resolves.toEqual(outcome)
      expect(resolved).toBe(0)
    },
  )

  it('rejects system actor before persistence', async () => {
    const command = new UndoLastOwnActionCommand(
      new ImmediateExecutor(),
      members(),
      facts(),
    )
    await expect(
      command.execute({
        ...undo(),
        trustedActor: { kind: 'system', id: 'planner-worker' },
      }),
    ).rejects.toBeInstanceOf(TrackingAuthorizationDeniedError)
  })

  it.each(['nothing_to_undo', 'not_latest', 'superseded'] as const)(
    'preserves finite %s persistence error',
    async (reason) => {
      const expected = new FactUndoUnavailableError(reason)
      const command = new UndoLastOwnActionCommand(
        new ImmediateExecutor(),
        members(),
        facts([], expected),
      )
      await expect(command.execute(undo())).rejects.toBe(expected)
    },
  )
})
