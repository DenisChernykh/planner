import { CreateDraftFromSeedCommand } from '@/modules/planning/application/create-draft-from-seed.command'
import type { PlanDraftPersistencePort } from '@/modules/planning/application/plan-draft-persistence.port'
import type { CreateDraftFromSeedApplicationCommand } from '@/modules/planning/application/planning.types'
import type { SeedOwnerBindingPort } from '@/modules/planning/application/seed-owner-binding.port'
import {
  PlanMonthAlreadyExistsError,
  PlanSeedAlreadyConsumedError,
} from '@/modules/planning/application/planning-errors'
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
const actorMemberId = '22222222-2222-4222-8222-222222222222'
const otherMemberId = '33333333-3333-4333-8333-333333333333'
const spaceId = '44444444-4444-4444-8444-444444444444'
const planMonthId = '55555555-5555-4555-8555-555555555555'
const commandId = '66666666-6666-4666-8666-666666666666'

class ImmediateExecutor implements CommandExecutor {
  public calls = 0
  public definition: CommandDefinition<unknown, string> | undefined
  public command: ApplicationCommand<unknown> | undefined
  public readonly occurredAt = new Date('2026-04-01T00:00:00.123Z')

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
      DurableCommandResultRef<'planning.plan-draft.v1'> | Error,
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

function owners(
  overrides: Partial<SeedOwnerBindingPort> = {},
): SeedOwnerBindingPort {
  return {
    resolvePair: () =>
      Promise.resolve({
        denisMemberId: actorMemberId,
        tanyaMemberId: otherMemberId,
      }),
    ...overrides,
  }
}

function drafts(
  overrides: Partial<PlanDraftPersistencePort> = {},
): PlanDraftPersistencePort {
  return {
    createEmptyDraft: () => Promise.reject(new Error('unexpected create')),
    createFromPublication: () => Promise.reject(new Error('unexpected copy')),
    createFromSeed: () => Promise.reject(new Error('unexpected seed')),
    updateFocus: () => Promise.reject(new Error('unexpected update')),
    findDraft: () => Promise.reject(new Error('unexpected find')),
    ...overrides,
  }
}

function validCommand(): CreateDraftFromSeedApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member', id: actorMemberId },
    payload: { targetMonth: '2026-04', actorPersona: 'memberA' },
  }
}

describe('P11 create draft from April seed command boundary', () => {
  it('snapshots the exact contract, binds personas and materializes revision one', async () => {
    const executor = new ImmediateExecutor()
    const ownerInputs: unknown[] = []
    const persistenceInputs: Record<string, unknown>[] = []
    const command = new CreateDraftFromSeedCommand(
      executor,
      members(),
      owners({
        resolvePair: (input) => {
          ownerInputs.push(input)
          return Promise.resolve({
            denisMemberId: actorMemberId,
            tanyaMemberId: otherMemberId,
          })
        },
      }),
      drafts({
        createFromSeed: (input) => {
          persistenceInputs.push(input)
          return Promise.resolve({
            status: 'created',
            draft: { planMonthId, draftRevision: 1n },
          })
        },
      }),
    )

    await expect(command.execute(validCommand())).resolves.toEqual({
      kind: 'planning.plan-draft.v1',
      aggregateId: planMonthId,
      aggregateRevision: 1n,
    })
    expect(executor.definition).toMatchObject({
      commandType: 'planning.create-draft-from-seed.v1',
      resultKind: 'planning.plan-draft.v1',
    })
    expect(executor.command).toEqual(validCommand())
    expect(ownerInputs).toEqual([
      { spaceId, actorMemberId, actorPersona: 'memberA' },
    ])
    expect(persistenceInputs).toHaveLength(1)
    expect(persistenceInputs[0]).toMatchObject({
      actor: { kind: 'member', id: actorMemberId },
      actorScope: `member:${actorMemberId}`,
      commandType: 'planning.create-draft-from-seed.v1',
      commandId,
      occurredAt: executor.occurredAt,
      spaceId,
      memberId: actorMemberId,
      actorPersona: 'memberA',
      targetMonth: '2026-04',
      denisMemberId: actorMemberId,
      tanyaMemberId: otherMemberId,
      seed: {
        schemaVersion: 'planner.april-plan-seed.v1',
        seedId: 'april-plan',
        seedVersion: 1,
        focus: 'Показатель 108',
      },
    })
    expect(
      (persistenceInputs[0]?.['seed'] as { goals: readonly unknown[] }).goals,
    ).toHaveLength(41)
  })

  it.each([
    ['expected revision', { ...validCommand(), expectedRevision: 1n }],
    [
      'invalid persona',
      {
        ...validCommand(),
        payload: { targetMonth: '2026-04', actorPersona: 'admin' },
      },
    ],
    [
      'invalid calendar month',
      {
        ...validCommand(),
        payload: { targetMonth: '0000-04', actorPersona: 'memberA' },
      },
    ],
    [
      'extra payload field',
      {
        ...validCommand(),
        payload: {
          targetMonth: '2026-04',
          actorPersona: 'memberA',
          seedId: 'forged',
        },
      },
    ],
  ])('rejects %s before executor invocation', async (_name, value) => {
    const executor = new ImmediateExecutor()
    await expect(
      new CreateDraftFromSeedCommand(
        executor,
        members(),
        owners(),
        drafts(),
      ).execute(value as never),
    ).rejects.toBeInstanceOf(CommandValidationError)
    expect(executor.calls).toBe(0)
  })

  it('does not evaluate accessors while validating the request', async () => {
    const executor = new ImmediateExecutor()
    let reads = 0
    const value = validCommand()
    Object.defineProperty(value, 'payload', {
      enumerable: true,
      get: () => {
        reads += 1
        return { targetMonth: '2026-04', actorPersona: 'memberA' }
      },
    })

    await expect(
      new CreateDraftFromSeedCommand(
        executor,
        members(),
        owners(),
        drafts(),
      ).execute(value as never),
    ).rejects.toBeInstanceOf(CommandValidationError)
    expect({ reads, calls: executor.calls }).toEqual({ reads: 0, calls: 0 })
  })

  it.each([
    [
      'exact replay',
      {
        kind: 'planning.plan-draft.v1' as const,
        aggregateId: planMonthId,
        aggregateRevision: 1n,
      },
    ],
    ['fingerprint conflict', new CommandFingerprintConflictError()],
  ])(
    '%s short-circuits membership, binding and persistence',
    async (_name, outcome) => {
      let reads = 0
      const command = new CreateDraftFromSeedCommand(
        new ShortCircuitExecutor(outcome),
        members({
          resolveMember: () => {
            reads += 1
            return Promise.reject(new Error('unexpected member read'))
          },
        }),
        owners({
          resolvePair: () => {
            reads += 1
            return Promise.reject(new Error('unexpected pair read'))
          },
        }),
        drafts({
          createFromSeed: () => {
            reads += 1
            return Promise.reject(new Error('unexpected persistence'))
          },
        }),
      )

      if (outcome instanceof Error) {
        await expect(command.execute(validCommand())).rejects.toBe(outcome)
      } else {
        await expect(command.execute(validCommand())).resolves.toBe(outcome)
      }
      expect(reads).toBe(0)
    },
  )

  it('rejects a system actor before membership, binding and persistence', async () => {
    let reads = 0
    const command = new CreateDraftFromSeedCommand(
      new ImmediateExecutor(),
      members({
        resolveMember: () => {
          reads += 1
          return Promise.reject(new Error('unexpected member read'))
        },
      }),
      owners({
        resolvePair: () => {
          reads += 1
          return Promise.reject(new Error('unexpected pair read'))
        },
      }),
      drafts({
        createFromSeed: () => {
          reads += 1
          return Promise.reject(new Error('unexpected persistence'))
        },
      }),
    )

    await expect(
      command.execute({
        ...validCommand(),
        trustedActor: { kind: 'system', id: 'planner-worker' },
      }),
    ).rejects.toMatchObject({ name: 'PlanningAuthorizationDeniedError' })
    expect(reads).toBe(0)
  })

  it.each([
    new PlanSeedAlreadyConsumedError(planMonthId, 'april-plan', 1),
    new PlanMonthAlreadyExistsError({
      kind: 'planning.plan-draft.v1',
      aggregateId: planMonthId,
      aggregateRevision: 2n,
    }),
  ])('preserves finite persistence error %s', async (error) => {
    const command = new CreateDraftFromSeedCommand(
      new ImmediateExecutor(),
      members(),
      owners(),
      drafts({ createFromSeed: () => Promise.reject(error) }),
    )
    await expect(command.execute(validCommand())).rejects.toBe(error)
  })
})
