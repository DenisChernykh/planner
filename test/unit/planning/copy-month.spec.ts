import { CreateDraftFromPublicationCommand } from '@/modules/planning/application/create-draft-from-publication.command'
import type { PlanDraftPersistencePort } from '@/modules/planning/application/plan-draft-persistence.port'
import type { CreateDraftFromPublicationApplicationCommand } from '@/modules/planning/application/planning.types'
import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type {
  ApplicationCommand,
  CommandDefinition,
  CommandExecutionContext,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import { CommandValidationError } from '@/shared/application/application-command'

const userId = '11111111-1111-4111-8111-111111111111'
const memberId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const sourcePublicationId = '44444444-4444-4444-8444-444444444444'
const destinationPlanMonthId = '55555555-5555-4555-8555-555555555555'
const commandId = '66666666-6666-4666-8666-666666666666'

class ImmediateExecutor implements CommandExecutor {
  public calls = 0
  public definition: CommandDefinition<unknown, string> | undefined
  public command: ApplicationCommand<unknown> | undefined
  public readonly occurredAt = new Date('2026-05-01T00:00:00.123Z')

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

const workspaceMembers: WorkspaceMemberResolver = {
  resolveUser: () => Promise.reject(new Error('unexpected resolveUser')),
  resolveTelegramId: () =>
    Promise.reject(new Error('unexpected resolveTelegramId')),
  resolveMember: (id) => Promise.resolve({ spaceId, memberId: id, userId }),
}

function drafts(
  overrides: Partial<PlanDraftPersistencePort>,
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

function validCommand(): CreateDraftFromPublicationApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    payload: { sourcePublicationId, targetMonth: '2026-05' },
  }
}

describe('P09 create draft from publication command boundary', () => {
  it('snapshots the exact command and passes one durable timestamp to persistence', async () => {
    const executor = new ImmediateExecutor()
    const inputs: Record<string, unknown>[] = []
    const command = new CreateDraftFromPublicationCommand(
      executor,
      workspaceMembers,
      drafts({
        createFromPublication: (input) => {
          inputs.push(input)
          return Promise.resolve({
            status: 'created',
            draft: {
              planMonthId: destinationPlanMonthId,
              draftRevision: 1n,
            },
          })
        },
      }),
    )

    await expect(command.execute(validCommand())).resolves.toEqual({
      kind: 'planning.plan-draft.v1',
      aggregateId: destinationPlanMonthId,
      aggregateRevision: 1n,
    })
    expect(executor.definition).toMatchObject({
      commandType: 'planning.create-draft-from-publication.v1',
      resultKind: 'planning.plan-draft.v1',
    })
    expect(executor.command).toEqual(validCommand())
    expect(inputs).toEqual([
      {
        actor: { kind: 'member', id: memberId },
        actorScope: `member:${memberId}`,
        commandType: 'planning.create-draft-from-publication.v1',
        commandId,
        occurredAt: new Date('2026-05-01T00:00:00.123Z'),
        spaceId,
        memberId,
        sourcePublicationId,
        targetMonth: '2026-05',
      },
    ])
  })

  it.each([
    ['expected revision', { ...validCommand(), expectedRevision: 1n }],
    [
      'uppercase publication ID',
      {
        ...validCommand(),
        payload: {
          sourcePublicationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
          targetMonth: '2026-05',
        },
      },
    ],
    [
      'invalid calendar month',
      {
        ...validCommand(),
        payload: { sourcePublicationId, targetMonth: '0000-12' },
      },
    ],
    [
      'extra payload field',
      {
        ...validCommand(),
        payload: {
          sourcePublicationId,
          targetMonth: '2026-05',
          focus: 'forged',
        },
      },
    ],
  ])('rejects %s before executor invocation', async (_name, value) => {
    const executor = new ImmediateExecutor()
    const command = new CreateDraftFromPublicationCommand(
      executor,
      workspaceMembers,
      drafts({}),
    )

    await expect(command.execute(value as never)).rejects.toBeInstanceOf(
      CommandValidationError,
    )
    expect(executor.calls).toBe(0)
  })

  it('rejects accessors without evaluating them', async () => {
    const executor = new ImmediateExecutor()
    let reads = 0
    const value = validCommand()
    Object.defineProperty(value, 'payload', {
      enumerable: true,
      get: () => {
        reads += 1
        return { sourcePublicationId, targetMonth: '2026-05' }
      },
    })

    await expect(
      new CreateDraftFromPublicationCommand(
        executor,
        workspaceMembers,
        drafts({}),
      ).execute(value as never),
    ).rejects.toBeInstanceOf(CommandValidationError)
    expect({ reads, calls: executor.calls }).toEqual({ reads: 0, calls: 0 })
  })

  it('rejects a non-member actor before membership and persistence access', async () => {
    const executor = new ImmediateExecutor()
    let memberReads = 0
    let persistenceWrites = 0
    const command = new CreateDraftFromPublicationCommand(
      executor,
      {
        ...workspaceMembers,
        resolveMember: () => {
          memberReads += 1
          return Promise.resolve({ spaceId, memberId, userId })
        },
      },
      drafts({
        createFromPublication: () => {
          persistenceWrites += 1
          return Promise.reject(new Error('unexpected copy'))
        },
      }),
    )

    await expect(
      command.execute({
        ...validCommand(),
        trustedActor: { kind: 'system', id: 'planner-worker' },
      }),
    ).rejects.toMatchObject({ name: 'PlanningAuthorizationDeniedError' })
    expect({ memberReads, persistenceWrites }).toEqual({
      memberReads: 0,
      persistenceWrites: 0,
    })
  })
})
