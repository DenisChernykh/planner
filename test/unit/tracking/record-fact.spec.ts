import { RecordFactCommand } from '@/modules/tracking/application/record-fact.command'
import type { FactPersistencePort } from '@/modules/tracking/application/fact-persistence.port'
import type { RecordFactApplicationCommand } from '@/modules/tracking/application/tracking.types'
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

const userId = '11111111-1111-4111-8111-111111111111'
const memberId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const publicationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const snapshotId = '55555555-5555-4555-8555-555555555555'
const factRecordId = '66666666-6666-4666-8666-666666666666'
const commandId = '77777777-7777-4777-8777-777777777777'

class ImmediateExecutor implements CommandExecutor {
  public calls = 0
  public definition: CommandDefinition<unknown, string> | undefined
  public command: ApplicationCommand<unknown> | undefined

  public constructor(
    public readonly occurredAt = new Date('2026-04-09T20:00:00.123Z'),
  ) {}

  public async execute<TPayload, K extends string>(
    definition: CommandDefinition<TPayload, K>,
    command: ApplicationCommand<TPayload>,
    effect: (
      context: CommandExecutionContext,
    ) => Promise<DurableCommandResultRef<K>>,
  ): Promise<DurableCommandResultRef<K>> {
    this.calls += 1
    this.definition = definition as CommandDefinition<unknown, string>
    this.command = command
    return effect({ occurredAt: new Date(this.occurredAt.getTime()) })
  }
}

class ShortCircuitExecutor implements CommandExecutor {
  public constructor(
    private readonly outcome:
      DurableCommandResultRef<'tracking.fact-record.v1'> | Error,
  ) {}

  public execute<TPayload, K extends string>(
    definition: CommandDefinition<TPayload, K>,
    command: ApplicationCommand<TPayload>,
    effect: (
      context: CommandExecutionContext,
    ) => Promise<DurableCommandResultRef<K>>,
  ): Promise<DurableCommandResultRef<K>> {
    void definition
    void command
    void effect
    if (this.outcome instanceof Error) return Promise.reject(this.outcome)
    return Promise.resolve(this.outcome as DurableCommandResultRef<K>)
  }
}

function members(
  overrides: Partial<WorkspaceMemberResolver> = {},
): WorkspaceMemberResolver {
  return {
    resolveUser: () => Promise.reject(new Error('unexpected resolveUser')),
    resolveTelegramId: () =>
      Promise.reject(new Error('unexpected resolveTelegramId')),
    resolveMember: (id) => Promise.resolve({ spaceId, memberId: id, userId }),
    ...overrides,
  }
}

function facts(
  overrides: Partial<FactPersistencePort> = {},
): FactPersistencePort {
  return {
    record: () => Promise.reject(new Error('unexpected record')),
    getState: () => Promise.reject(new Error('unexpected state')),
    getGoalProgressInput: () =>
      Promise.reject(new Error('unexpected progress input')),
    ...overrides,
  }
}

function validCommand(): RecordFactApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    payload: {
      publicationId,
      planGoalSnapshotId: snapshotId,
      localDate: '2026-04-10',
      value: { kind: 'quantity', value: '400' },
    },
  }
}

describe('T01 record fact application boundary', () => {
  it('snapshots the exact payload and passes trusted context to persistence', async () => {
    const executor = new ImmediateExecutor()
    const inputs: unknown[] = []
    const command = new RecordFactCommand(
      executor,
      members(),
      facts({
        record: (input) => {
          inputs.push(input)
          return Promise.resolve({ factRecordId, factRevision: 1n })
        },
      }),
    )

    await expect(command.execute(validCommand())).resolves.toEqual({
      kind: 'tracking.fact-record.v1',
      aggregateId: factRecordId,
      aggregateRevision: 1n,
    })
    expect(executor.definition).toMatchObject({
      commandType: 'tracking.record-fact.v1',
      resultKind: 'tracking.fact-record.v1',
    })
    expect(executor.command).toEqual(validCommand())
    expect(inputs).toEqual([
      {
        actor: { kind: 'member', id: memberId },
        actorScope: `member:${memberId}`,
        commandType: 'tracking.record-fact.v1',
        commandId,
        occurredAt: executor.occurredAt,
        currentLocalDate: '2026-04-10',
        spaceId,
        memberId,
        expectedRevision: null,
        checkpointId: null,
        checklistItemId: null,
        publicationId,
        planGoalSnapshotId: snapshotId,
        localDate: '2026-04-10',
        value: { kind: 'quantity', value: '400' },
      },
    ])
  })

  it.each([
    [
      'uppercase UUID',
      {
        ...validCommand(),
        payload: {
          ...validCommand().payload,
          publicationId: publicationId.toUpperCase(),
        },
      },
    ],
    [
      'year zero',
      {
        ...validCommand(),
        payload: { ...validCommand().payload, localDate: '0000-04-10' },
      },
    ],
    [
      'signed decimal',
      {
        ...validCommand(),
        payload: {
          ...validCommand().payload,
          value: { kind: 'quantity', value: '+400' },
        },
      },
    ],
    [
      'negative decimal',
      {
        ...validCommand(),
        payload: {
          ...validCommand().payload,
          value: { kind: 'quantity', value: '-1' },
        },
      },
    ],
    [
      'extra value field',
      {
        ...validCommand(),
        payload: {
          ...validCommand().payload,
          value: { kind: 'boolean', result: 'done', extra: true },
        },
      },
    ],
    [
      'extra payload field',
      {
        ...validCommand(),
        payload: { ...validCommand().payload, reason: 'not in T01' },
      },
    ],
    ['zero expected revision', { ...validCommand(), expectedRevision: 0n }],
  ])('rejects %s before executor invocation', async (_label, input) => {
    const executor = new ImmediateExecutor()
    await expect(
      new RecordFactCommand(executor, members(), facts()).execute(
        input as never,
      ),
    ).rejects.toBeInstanceOf(CommandValidationError)
    expect(executor.calls).toBe(0)
  })

  it('rejects accessors without evaluating them', async () => {
    const executor = new ImmediateExecutor()
    let reads = 0
    const input = validCommand()
    Object.defineProperty(input, 'payload', {
      enumerable: true,
      get: () => {
        reads += 1
        return validCommand().payload
      },
    })

    await expect(
      new RecordFactCommand(executor, members(), facts()).execute(input),
    ).rejects.toBeInstanceOf(CommandValidationError)
    expect({ reads, calls: executor.calls }).toEqual({ reads: 0, calls: 0 })
  })

  it.each([
    [
      'exact replay',
      {
        kind: 'tracking.fact-record.v1' as const,
        aggregateId: factRecordId,
        aggregateRevision: 1n,
      },
    ],
    ['fingerprint conflict', new CommandFingerprintConflictError()],
  ])('%s precedes membership and persistence', async (_label, outcome) => {
    let memberReads = 0
    let persistenceReads = 0
    const command = new RecordFactCommand(
      new ShortCircuitExecutor(outcome),
      members({
        resolveMember: () => {
          memberReads += 1
          return Promise.reject(new Error('unexpected membership'))
        },
      }),
      facts({
        record: () => {
          persistenceReads += 1
          return Promise.reject(new Error('unexpected persistence'))
        },
      }),
    )

    const result = command.execute(validCommand())
    if (outcome instanceof Error) await expect(result).rejects.toBe(outcome)
    else await expect(result).resolves.toEqual(outcome)
    expect({ memberReads, persistenceReads }).toEqual({
      memberReads: 0,
      persistenceReads: 0,
    })
  })

  it('forwards a positive CAS revision unchanged', async () => {
    const inputs: unknown[] = []
    const command = new RecordFactCommand(
      new ImmediateExecutor(),
      members(),
      facts({
        record: (input) => {
          inputs.push(input.expectedRevision)
          return Promise.resolve({ factRecordId, factRevision: 2n })
        },
      }),
    )
    await command.execute({ ...validCommand(), expectedRevision: 1n })
    expect(inputs).toEqual([1n])
  })
})
