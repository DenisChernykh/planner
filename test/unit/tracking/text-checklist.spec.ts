import {
  RecordChecklistItemCommand,
  RecordTextCommand,
  type RecordChecklistItemApplicationCommand,
  type RecordTextApplicationCommand,
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
const checklistItemId = '66666666-6666-4666-8666-666666666666'
const commandId = '77777777-7777-4777-8777-777777777777'
const factRecordId = '88888888-8888-4888-8888-888888888888'

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
    _definition: CommandDefinition<TPayload, K>,
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

function textCommand(
  checkpoint: string | null = null,
): RecordTextApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    payload: {
      publicationId,
      planGoalSnapshotId: snapshotId,
      expectationDate: '2026-04-10',
      checkpointId: checkpoint,
      text: 'Одна важная задача',
      result: 'done',
    },
  }
}

function checklistCommand(
  checkpoint: string | null = null,
): RecordChecklistItemApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    payload: {
      publicationId,
      planGoalSnapshotId: snapshotId,
      expectationDate: '2026-04-10',
      checkpointId: checkpoint,
      checklistItemId,
      state: 'not_done',
    },
  }
}

describe('T03 text and checklist command boundaries', () => {
  it.each([
    [
      'text',
      'tracking.record-text.v1',
      (executor: CommandExecutor, persistence: FactPersistencePort) =>
        new RecordTextCommand(executor, members(), persistence).execute(
          textCommand(checkpointId),
        ),
      checkpointId,
      null,
      { kind: 'text', text: 'Одна важная задача', result: 'done' },
    ],
    [
      'checklist item',
      'tracking.record-checklist-item.v1',
      (executor: CommandExecutor, persistence: FactPersistencePort) =>
        new RecordChecklistItemCommand(
          executor,
          members(),
          persistence,
        ).execute(checklistCommand()),
      null,
      checklistItemId,
      { kind: 'checklist_item', state: 'not_done' },
    ],
  ])(
    'snapshots exact %s payload and stable component IDs',
    async (
      _label,
      commandType,
      execute,
      expectedCheckpointId,
      expectedChecklistItemId,
      value,
    ) => {
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
          checkpointId: expectedCheckpointId,
          checklistItemId: expectedChecklistItemId,
          value,
        }),
      ])
    },
  )

  it.each([
    [
      'empty text',
      { ...textCommand(), payload: { ...textCommand().payload, text: '' } },
    ],
    [
      'whitespace text',
      { ...textCommand(), payload: { ...textCommand().payload, text: ' \n ' } },
    ],
    [
      'missing nullable checkpoint',
      {
        ...textCommand(),
        payload: {
          publicationId,
          planGoalSnapshotId: snapshotId,
          expectationDate: '2026-04-10',
          text: 'Одна важная задача',
          result: 'done',
        },
      },
    ],
    [
      'bad text result',
      {
        ...textCommand(),
        payload: { ...textCommand().payload, result: 'skipped' },
      },
    ],
    [
      'bad checklist state',
      {
        ...checklistCommand(),
        payload: { ...checklistCommand().payload, state: 'skipped' },
      },
    ],
    [
      'bad checklist item ID',
      {
        ...checklistCommand(),
        payload: { ...checklistCommand().payload, checklistItemId: 'item-1' },
      },
    ],
    [
      'extra payload field',
      {
        ...checklistCommand(),
        payload: { ...checklistCommand().payload, extra: true },
      },
    ],
    ['zero revision', { ...textCommand(), expectedRevision: 0n }],
  ])('rejects %s before executor', (_label, input) => {
    const executor = new ImmediateExecutor()
    const command =
      'text' in (input as { payload: object }).payload
        ? new RecordTextCommand(executor, members(), facts())
        : new RecordChecklistItemCommand(executor, members(), facts())
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
    const execute = new RecordTextCommand(
      new ShortCircuitExecutor(outcome),
      members(() => {
        membershipReads += 1
      }),
      facts([], () => {
        persistenceReads += 1
      }),
    ).execute(textCommand())
    if (outcome instanceof Error) await expect(execute).rejects.toBe(outcome)
    else await expect(execute).resolves.toEqual(outcome)
    expect({ membershipReads, persistenceReads }).toEqual({
      membershipReads: 0,
      persistenceReads: 0,
    })
  })
})
