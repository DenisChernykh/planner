import type { WorkspaceMemberResolver } from '@/modules/workspace'
import { CancelPublicationCommand } from '@/modules/planning/application/cancel-publication.command'
import type { PublicationPersistencePort } from '@/modules/planning/application/publication-persistence.port'
import type {
  CancelPublicationApplicationCommand,
  PublishMonthApplicationCommand,
} from '@/modules/planning/application/publication.types'
import { RepublishMonthCommand } from '@/modules/planning/application/republish-month.command'
import type {
  ApplicationCommand,
  CommandDefinition,
  CommandExecutionContext,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import { CommandValidationError } from '@/shared/application/application-command'

const memberId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const planMonthId = '44444444-4444-4444-8444-444444444444'
const publicationId = '55555555-5555-4555-8555-555555555555'
const commandId = '66666666-6666-4666-8666-666666666666'

class ImmediateExecutor implements CommandExecutor {
  public calls = 0
  public definition: CommandDefinition<unknown, string> | undefined
  public readonly occurredAt = new Date('2026-08-14T19:00:00.000Z')

  public async execute<TPayload, K extends string>(
    definition: CommandDefinition<TPayload, K>,
    _command: ApplicationCommand<TPayload>,
    effect: (
      context: CommandExecutionContext,
    ) => Promise<DurableCommandResultRef<K>>,
  ): Promise<DurableCommandResultRef<K>> {
    this.calls += 1
    this.definition = definition as CommandDefinition<unknown, string>
    return effect({ occurredAt: new Date(this.occurredAt.getTime()) })
  }
}

const workspaceMembers: WorkspaceMemberResolver = {
  resolveUser: () => Promise.reject(new Error('unexpected resolveUser')),
  resolveTelegramId: () =>
    Promise.reject(new Error('unexpected resolveTelegramId')),
  resolveMember: (id) => Promise.resolve({ spaceId, memberId: id, userId }),
}

function publications(
  overrides: Partial<PublicationPersistencePort>,
): PublicationPersistencePort {
  return {
    publish: () => Promise.reject(new Error('unexpected publish')),
    cancel: () => Promise.reject(new Error('unexpected cancel')),
    findPublished: () => Promise.reject(new Error('unexpected findPublished')),
    findActive: () => Promise.reject(new Error('unexpected findActive')),
    ...overrides,
  }
}

function cancelCommand(): CancelPublicationApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    expectedRevision: 2n,
    payload: { planMonthId, publicationId },
  }
}

function republishCommand(): PublishMonthApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member' as const, id: memberId },
    expectedRevision: 7n,
    payload: {
      planMonthId,
      previewSchemaVersion: 'planner.publication-preview.v1',
      previewHashVersion: 'planner.publication-preview-hash.v1',
      previewHash: 'ab'.repeat(32),
    },
  }
}

describe('P08 cancel and republish command boundaries', () => {
  it('snapshots cancellation and passes one occurredAt-derived local date to persistence', async () => {
    const executor = new ImmediateExecutor()
    const inputs: Record<string, unknown>[] = []
    const command = new CancelPublicationCommand(
      executor,
      workspaceMembers,
      publications({
        cancel: (input) => {
          inputs.push(input)
          return Promise.resolve({ planMonthId, planMonthRevision: 3n })
        },
      }),
    )

    await expect(command.execute(cancelCommand())).resolves.toEqual({
      kind: 'planning.plan-month.v1',
      aggregateId: planMonthId,
      aggregateRevision: 3n,
    })
    expect(executor.definition).toMatchObject({
      commandType: 'planning.cancel-publication.v1',
      resultKind: 'planning.plan-month.v1',
    })
    expect(inputs).toEqual([
      {
        actor: { kind: 'member', id: memberId },
        actorScope: `member:${memberId}`,
        commandType: 'planning.cancel-publication.v1',
        commandId,
        occurredAt: new Date('2026-08-14T19:00:00.000Z'),
        localDate: '2026-08-15',
        spaceId,
        memberId,
        planMonthId,
        publicationId,
        expectedPlanMonthRevision: 2n,
      },
    ])
  })

  it('uses the P07 payload contract with an explicit republish mode', async () => {
    const executor = new ImmediateExecutor()
    const inputs: Record<string, unknown>[] = []
    const command = new RepublishMonthCommand(
      executor,
      workspaceMembers,
      publications({
        publish: (input) => {
          inputs.push(input)
          return Promise.resolve({ publicationId, publicationRevision: 2n })
        },
      }),
    )

    await expect(command.execute(republishCommand())).resolves.toEqual({
      kind: 'planning.plan-publication.v1',
      aggregateId: publicationId,
      aggregateRevision: 2n,
    })
    expect(executor.definition).toMatchObject({
      commandType: 'planning.republish-month.v1',
      resultKind: 'planning.plan-publication.v1',
    })
    expect(inputs).toEqual([
      expect.objectContaining({
        commandType: 'planning.republish-month.v1',
        publicationMode: 'republish',
        localDate: '2026-08-15',
        planMonthId,
        expectedDraftRevision: 7n,
      }),
    ])
  })

  it.each([
    ['missing cancel revision', { ...cancelCommand(), expectedRevision: 0n }],
    [
      'extra cancel payload field',
      {
        ...cancelCommand(),
        payload: { ...cancelCommand().payload, targetMonth: '2026-09' },
      },
    ],
    [
      'uppercase republish hash',
      {
        ...republishCommand(),
        payload: {
          ...republishCommand().payload,
          previewHash: 'AB'.repeat(32),
        },
      },
    ],
  ])('rejects %s before executor invocation', (_name, input) => {
    const executor = new ImmediateExecutor()
    const cancellation = new CancelPublicationCommand(
      executor,
      workspaceMembers,
      publications({}),
    )
    const republish = new RepublishMonthCommand(
      executor,
      workspaceMembers,
      publications({}),
    )
    const target = _name.includes('republish') ? republish : cancellation

    expect(() => target.execute(input as never)).toThrow(CommandValidationError)
    expect(executor.calls).toBe(0)
  })
})
