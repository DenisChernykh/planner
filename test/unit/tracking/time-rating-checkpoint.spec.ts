import {
  RecordCheckpointCommand,
  RecordRatingCommand,
  RecordTimeCommand,
  type RecordCheckpointApplicationCommand,
  type RecordRatingApplicationCommand,
  type RecordTimeApplicationCommand,
} from '@/modules/tracking'
import type { FactPersistencePort } from '@/modules/tracking'
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
const snapshotId = '44444444-4444-4444-8444-444444444444'
const checkpointId = '55555555-5555-4555-8555-555555555555'
const commandId = '66666666-6666-4666-8666-666666666666'
const factRecordId = '77777777-7777-4777-8777-777777777777'

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
    return effect({ occurredAt: new Date('2026-04-11T01:00:00.123Z') })
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
  onRecord: () => void = () => undefined,
): FactPersistencePort {
  return {
    record: (input) => {
      onRecord()
      inputs.push(input)
      return Promise.resolve({ factRecordId, factRevision: 1n })
    },
    mutate: () => Promise.reject(new Error('unexpected mutate')),
    getState: () => Promise.reject(new Error('unexpected getState')),
    getGoalProgressInput: () =>
      Promise.reject(new Error('unexpected getGoalProgressInput')),
  }
}

function timeCommand(): RecordTimeApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    payload: {
      publicationId,
      planGoalSnapshotId: snapshotId,
      expectationDate: '2026-04-10',
      value: '00:30',
    },
  }
}

function ratingCommand(): RecordRatingApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    payload: {
      publicationId,
      planGoalSnapshotId: snapshotId,
      expectationDate: '2026-04-10',
      value: 1,
    },
  }
}

function checkpointCommand(): RecordCheckpointApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    payload: {
      publicationId,
      planGoalSnapshotId: snapshotId,
      expectationDate: '2026-04-10',
      checkpointId,
      value: { kind: 'boolean', result: 'done' },
    },
  }
}

describe('T02 time, rating and checkpoint command boundaries', () => {
  it.each([
    [
      'time',
      'tracking.record-time.v1',
      (executor: CommandExecutor, persistence: FactPersistencePort) =>
        new RecordTimeCommand(executor, members(), persistence).execute(
          timeCommand(),
        ),
      { kind: 'actual_time', value: '00:30' },
      null,
    ],
    [
      'rating',
      'tracking.record-rating.v1',
      (executor: CommandExecutor, persistence: FactPersistencePort) =>
        new RecordRatingCommand(executor, members(), persistence).execute(
          ratingCommand(),
        ),
      { kind: 'rating', value: 1 },
      null,
    ],
    [
      'checkpoint',
      'tracking.record-checkpoint.v1',
      (executor: CommandExecutor, persistence: FactPersistencePort) =>
        new RecordCheckpointCommand(executor, members(), persistence).execute(
          checkpointCommand(),
        ),
      { kind: 'boolean', result: 'done' },
      checkpointId,
    ],
  ])(
    'snapshots exact %s payload and forwards durable context',
    async (_label, commandType, execute, value, expectedCheckpointId) => {
      const executor = new ImmediateExecutor()
      const inputs: unknown[] = []
      await expect(execute(executor, facts(inputs))).resolves.toEqual({
        kind: 'tracking.fact-record.v1',
        aggregateId: factRecordId,
        aggregateRevision: 1n,
      })
      expect(executor.definition).toMatchObject({
        commandType,
        resultKind: 'tracking.fact-record.v1',
      })
      expect(inputs).toEqual([
        expect.objectContaining({
          commandType,
          commandId,
          occurredAt: new Date('2026-04-11T01:00:00.123Z'),
          currentLocalDate: '2026-04-11',
          spaceId,
          memberId,
          expectedRevision: null,
          publicationId,
          planGoalSnapshotId: snapshotId,
          localDate: '2026-04-10',
          checkpointId: expectedCheckpointId,
          value,
        }),
      ])
    },
  )

  it.each([
    [
      'invalid time',
      {
        ...timeCommand(),
        payload: { ...timeCommand().payload, value: '24:00' },
      },
    ],
    [
      'time seconds',
      {
        ...timeCommand(),
        payload: { ...timeCommand().payload, value: '00:30:00' },
      },
    ],
    [
      'unsafe rating',
      {
        ...ratingCommand(),
        payload: {
          ...ratingCommand().payload,
          value: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    ],
    [
      'fractional rating',
      {
        ...ratingCommand(),
        payload: { ...ratingCommand().payload, value: 1.5 },
      },
    ],
    [
      'missing checkpoint',
      {
        ...checkpointCommand(),
        payload: { ...checkpointCommand().payload, checkpointId: undefined },
      },
    ],
    [
      'unknown checkpoint value kind',
      {
        ...checkpointCommand(),
        payload: {
          ...checkpointCommand().payload,
          value: { kind: 'text', text: 'no' },
        },
      },
    ],
    [
      'extra field',
      { ...timeCommand(), payload: { ...timeCommand().payload, extra: true } },
    ],
    ['zero revision', { ...ratingCommand(), expectedRevision: 0n }],
  ])('rejects %s before executor', (_label, input) => {
    const executor = new ImmediateExecutor()
    const command =
      'checkpointId' in (input as { payload: object }).payload
        ? new RecordCheckpointCommand(executor, members(), facts())
        : typeof (input as { payload: { value: unknown } }).payload.value ===
            'number'
          ? new RecordRatingCommand(executor, members(), facts())
          : new RecordTimeCommand(executor, members(), facts())
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
        aggregateRevision: 1n,
      },
    ],
    ['fingerprint conflict', new CommandFingerprintConflictError()],
  ])('%s precedes membership and persistence', async (_label, outcome) => {
    let membershipReads = 0
    let persistenceReads = 0
    const execute = new RecordCheckpointCommand(
      new ShortCircuitExecutor(outcome),
      members(() => {
        membershipReads += 1
      }),
      facts([], () => {
        persistenceReads += 1
      }),
    ).execute(checkpointCommand())
    if (outcome instanceof Error) await expect(execute).rejects.toBe(outcome)
    else await expect(execute).resolves.toEqual(outcome)
    expect({ membershipReads, persistenceReads }).toEqual({
      membershipReads: 0,
      persistenceReads: 0,
    })
  })
})
