import {
  CorrectRecordCommand,
  DeleteRecordCommand,
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
    _definition?: CommandDefinition<TPayload, K>,
  ): Promise<DurableCommandResultRef<K>> {
    void _definition
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

function facts(inputs: unknown[] = []): FactPersistencePort {
  return {
    record: () => Promise.reject(new Error('unexpected record')),
    mutate: (input) => {
      inputs.push(input)
      return Promise.resolve({ factRecordId, factRevision: 2n })
    },
    getState: () => Promise.reject(new Error('unexpected getState')),
    getGoalProgressInput: () =>
      Promise.reject(new Error('unexpected getGoalProgressInput')),
  }
}

function correction(): Parameters<CorrectRecordCommand['execute']>[0] {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    expectedRevision: 1n,
    payload: {
      factRecordId,
      value: { kind: 'text', text: 'Исправлено', result: 'done' },
      reason: 'Исправлена опечатка',
    },
  }
}

function deletion(): Parameters<DeleteRecordCommand['execute']>[0] {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    expectedRevision: 1n,
    payload: { factRecordId, reason: 'Ошибочная запись' },
  }
}

describe('T05 correction and tombstone application boundary', () => {
  it.each([
    [
      'correction',
      'tracking.correct-record.v1',
      correction(),
      (executor: CommandExecutor, persistence: FactPersistencePort) =>
        new CorrectRecordCommand(executor, members(), persistence),
      correction().payload.value,
    ],
    [
      'deletion',
      'tracking.delete-record.v1',
      deletion(),
      (executor: CommandExecutor, persistence: FactPersistencePort) =>
        new DeleteRecordCommand(executor, members(), persistence),
      null,
    ],
  ])(
    'snapshots exact %s payload and forwards audited mutation',
    async (_label, commandType, command, create, value) => {
      const executor = new ImmediateExecutor()
      const inputs: unknown[] = []
      await expect(
        create(executor, facts(inputs)).execute(command as never),
      ).resolves.toEqual({
        kind: 'tracking.fact-record.v1',
        aggregateId: factRecordId,
        aggregateRevision: 2n,
      })
      expect(executor.definition).toMatchObject({
        commandType,
        resultKind: 'tracking.fact-record.v1',
      })
      expect(inputs).toEqual([
        expect.objectContaining({
          commandType,
          factRecordId,
          expectedRevision: 1n,
          reason: command.payload.reason,
          value,
        }),
      ])
    },
  )

  it.each([
    ['missing revision', { ...correction(), expectedRevision: undefined }],
    ['zero revision', { ...correction(), expectedRevision: 0n }],
    [
      'empty reason',
      { ...correction(), payload: { ...correction().payload, reason: '  ' } },
    ],
    [
      'unknown value',
      {
        ...correction(),
        payload: { ...correction().payload, value: { kind: 'unknown' } },
      },
    ],
    [
      'extra delete field',
      { ...deletion(), payload: { ...deletion().payload, extra: true } },
    ],
  ])('rejects %s before executor', (_label, input) => {
    const executor = new ImmediateExecutor()
    const command =
      'value' in input.payload
        ? new CorrectRecordCommand(executor, members(), facts())
        : new DeleteRecordCommand(executor, members(), facts())
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
      const persistence = facts()
      const command = new CorrectRecordCommand(
        new ShortCircuitExecutor(outcome),
        members(() => {
          resolved += 1
        }),
        persistence,
      )
      const promise = command.execute(correction())
      if (outcome instanceof Error) await expect(promise).rejects.toBe(outcome)
      else await expect(promise).resolves.toEqual(outcome)
      expect(resolved).toBe(0)
    },
  )
})
