import {
  RecordCompositeOccurrenceCommand,
  RecordOrVariantCommand,
  type FactPersistencePort,
  type RecordCompositeOccurrenceApplicationCommand,
  type RecordOrVariantApplicationCommand,
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
const snapshotId = '44444444-4444-4444-8444-444444444444'
const checkpointId = '55555555-5555-4555-8555-555555555555'
const componentId = '66666666-6666-4666-8666-666666666666'
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
    getState: () => Promise.reject(new Error('unexpected getState')),
    getGoalProgressInput: () =>
      Promise.reject(new Error('unexpected getGoalProgressInput')),
  }
}

function orCommand(): RecordOrVariantApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    payload: {
      publicationId,
      planGoalSnapshotId: snapshotId,
      expectationDate: '2026-04-10',
      checkpointId,
      variantId: componentId,
      value: '0.5',
    },
  }
}

function compositeCommand(
  kind: 'checklist_item' | 'or_variant' = 'checklist_item',
): RecordCompositeOccurrenceApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    payload: {
      publicationId,
      planGoalSnapshotId: snapshotId,
      localDate: '2026-04-10',
      component:
        kind === 'checklist_item'
          ? { kind, checklistItemId: componentId, state: 'done' }
          : { kind, variantId: componentId, value: '2' },
    },
  }
}

describe('T04 OR and flexible composite command boundaries', () => {
  it.each([
    [
      'fixed OR variant',
      'tracking.record-or-variant.v1',
      (executor: CommandExecutor, persistence: FactPersistencePort) =>
        new RecordOrVariantCommand(executor, members(), persistence).execute(
          orCommand(),
        ),
      checkpointId,
      null,
      componentId,
      { kind: 'or_variant', value: '0.5' },
    ],
    [
      'flexible checklist item',
      'tracking.record-composite-occurrence.v1',
      (executor: CommandExecutor, persistence: FactPersistencePort) =>
        new RecordCompositeOccurrenceCommand(
          executor,
          members(),
          persistence,
        ).execute(compositeCommand()),
      null,
      componentId,
      null,
      { kind: 'checklist_item', state: 'done' },
    ],
    [
      'flexible OR variant',
      'tracking.record-composite-occurrence.v1',
      (executor: CommandExecutor, persistence: FactPersistencePort) =>
        new RecordCompositeOccurrenceCommand(
          executor,
          members(),
          persistence,
        ).execute(compositeCommand('or_variant')),
      null,
      null,
      componentId,
      { kind: 'or_variant', value: '2' },
    ],
  ])(
    'snapshots exact %s payload and stable component identity',
    async (
      _label,
      commandType,
      execute,
      expectedCheckpointId,
      expectedChecklistItemId,
      expectedOrVariantId,
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
          orVariantId: expectedOrVariantId,
          value,
        }),
      ])
    },
  )

  it.each([
    [
      'negative OR value',
      { ...orCommand(), payload: { ...orCommand().payload, value: '-1' } },
    ],
    [
      'exponent OR value',
      { ...orCommand(), payload: { ...orCommand().payload, value: '1e2' } },
    ],
    [
      'missing nullable checkpoint',
      {
        ...orCommand(),
        payload: {
          publicationId,
          planGoalSnapshotId: snapshotId,
          expectationDate: '2026-04-10',
          variantId: componentId,
          value: '1',
        },
      },
    ],
    [
      'unknown composite component',
      {
        ...compositeCommand(),
        payload: {
          ...compositeCommand().payload,
          component: { kind: 'boolean', result: 'done' },
        },
      },
    ],
    [
      'extra component field',
      {
        ...compositeCommand(),
        payload: {
          ...compositeCommand().payload,
          component: { ...compositeCommand().payload.component, extra: true },
        },
      },
    ],
    ['zero revision', { ...compositeCommand(), expectedRevision: 0n }],
  ])('rejects %s before executor', (_label, input) => {
    const executor = new ImmediateExecutor()
    const command =
      'expectationDate' in (input as { payload: object }).payload
        ? new RecordOrVariantCommand(executor, members(), facts())
        : new RecordCompositeOccurrenceCommand(executor, members(), facts())
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
    const execute = new RecordCompositeOccurrenceCommand(
      new ShortCircuitExecutor(outcome),
      members(() => {
        membershipReads += 1
      }),
      facts([], () => {
        persistenceReads += 1
      }),
    ).execute(compositeCommand())
    if (outcome instanceof Error) await expect(execute).rejects.toBe(outcome)
    else await expect(execute).resolves.toEqual(outcome)
    expect({ membershipReads, persistenceReads }).toEqual({
      membershipReads: 0,
      persistenceReads: 0,
    })
  })
})
