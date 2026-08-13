import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type {
  ApplicationCommand,
  CommandDefinition,
  CommandExecutionContext,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import { CommandValidationError } from '@/shared/application/application-command'
import { GetActiveMonthQuery } from '@/modules/planning/application/get-active-month.query'
import { GetPublishedSnapshotQuery } from '@/modules/planning/application/get-published-snapshot.query'
import type { PublicationPersistencePort } from '@/modules/planning/application/publication-persistence.port'
import { PublishMonthCommand } from '@/modules/planning/application/publish-month.command'
import type { ProductClock } from '@/shared/application/product-clock'

const memberId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const planMonthId = '44444444-4444-4444-8444-444444444444'
const publicationId = '55555555-5555-4555-8555-555555555555'

class ImmediateExecutor implements CommandExecutor {
  public calls = 0
  public definition: CommandDefinition<unknown, string> | undefined
  public command: ApplicationCommand<unknown> | undefined
  public readonly occurredAt = new Date('2026-08-14T19:00:00.000Z')

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

function commandClass(): new (
  executor: CommandExecutor,
  members: WorkspaceMemberResolver,
  publications: { publish(input: Record<string, unknown>): Promise<unknown> },
) => { execute(command: Record<string, unknown>): Promise<unknown> } {
  return PublishMonthCommand as unknown as ReturnType<typeof commandClass>
}

function validCommand(): Record<string, unknown> {
  return {
    commandId: '66666666-6666-4666-8666-666666666666',
    trustedActor: { kind: 'member', id: memberId },
    expectedRevision: 7n,
    payload: {
      planMonthId,
      previewSchemaVersion: 'planner.publication-preview.v1',
      previewHashVersion: 'planner.publication-preview-hash.v1',
      previewHash: 'cd'.repeat(32),
    },
  }
}

describe('P07 publish-month command boundary', () => {
  it('snapshots the exact command before the executor and passes one occurredAt-derived local date to persistence', async () => {
    const Executor = commandClass()
    const executor = new ImmediateExecutor()
    const inputs: Record<string, unknown>[] = []
    const command = new Executor(executor, workspaceMembers, {
      publish: (input) => {
        inputs.push(input)
        return Promise.resolve({ publicationId, publicationRevision: 1n })
      },
    })

    await expect(command.execute(validCommand())).resolves.toEqual({
      kind: 'planning.plan-publication.v1',
      aggregateId: publicationId,
      aggregateRevision: 1n,
    })
    expect(executor.definition).toMatchObject({
      commandType: 'planning.publish-month.v1',
      resultKind: 'planning.plan-publication.v1',
    })
    expect(inputs).toEqual([
      {
        actor: { kind: 'member', id: memberId },
        actorScope: `member:${memberId}`,
        commandType: 'planning.publish-month.v1',
        commandId: '66666666-6666-4666-8666-666666666666',
        occurredAt: new Date('2026-08-14T19:00:00.000Z'),
        localDate: '2026-08-15',
        spaceId,
        memberId,
        planMonthId,
        expectedDraftRevision: 7n,
        previewSchemaVersion: 'planner.publication-preview.v1',
        previewHashVersion: 'planner.publication-preview-hash.v1',
        previewHash: 'cd'.repeat(32),
      },
    ])
  })

  it('allows syntactically valid unknown versions to reach semantic transaction validation', async () => {
    const Executor = commandClass()
    const executor = new ImmediateExecutor()
    const inputs: Record<string, unknown>[] = []
    const command = new Executor(executor, workspaceMembers, {
      publish: (input) => {
        inputs.push(input)
        return Promise.resolve({ publicationId, publicationRevision: 1n })
      },
    })
    const value = validCommand()
    ;(value['payload'] as Record<string, unknown>)['previewSchemaVersion'] =
      'planner.publication-preview.v2'

    await command.execute(value)

    expect(inputs[0]?.['previewSchemaVersion']).toBe(
      'planner.publication-preview.v2',
    )
  })

  it.each([
    [
      'missing expected revision',
      { ...validCommand(), expectedRevision: undefined },
    ],
    [
      'noncanonical path ID',
      {
        ...validCommand(),
        payload: {
          ...(validCommand()['payload'] as object),
          planMonthId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        },
      },
    ],
    [
      'uppercase hash',
      {
        ...validCommand(),
        payload: {
          ...(validCommand()['payload'] as object),
          previewHash: 'AB'.repeat(32),
        },
      },
    ],
    [
      'extra payload field',
      {
        ...validCommand(),
        payload: {
          ...(validCommand()['payload'] as object),
          targetMonth: '2026-08',
        },
      },
    ],
  ])('rejects %s before executor invocation', (_name, input) => {
    const Executor = commandClass()
    const executor = new ImmediateExecutor()
    const command = new Executor(executor, workspaceMembers, {
      publish: () =>
        Promise.resolve({ publicationId, publicationRevision: 1n }),
    })

    expect(() => command.execute(input)).toThrow(CommandValidationError)
    expect(executor.calls).toBe(0)
  })

  it('rejects accessor payloads before invoking the accessor or executor', () => {
    const Executor = commandClass()
    const executor = new ImmediateExecutor()
    let reads = 0
    const input = validCommand()
    Object.defineProperty(input, 'payload', {
      enumerable: true,
      get: () => {
        reads += 1
        return validCommand()['payload']
      },
    })
    const command = new Executor(executor, workspaceMembers, {
      publish: () =>
        Promise.resolve({ publicationId, publicationRevision: 1n }),
    })

    expect(() => command.execute(input)).toThrow(CommandValidationError)
    expect(reads).toBe(0)
    expect(executor.calls).toBe(0)
  })

  it('resolves membership and reads the immutable publication exactly once', async () => {
    let resolverCalls = 0
    let readCalls = 0
    const members: WorkspaceMemberResolver = {
      ...workspaceMembers,
      resolveUser: (id) => {
        resolverCalls += 1
        expect(id).toBe(userId)
        return Promise.resolve({ spaceId, memberId, userId: id })
      },
    }
    const publications = publicationQueries({
      findPublished: (selectedSpaceId, selectedPublicationId) => {
        readCalls += 1
        expect([selectedSpaceId, selectedPublicationId]).toEqual([
          spaceId,
          publicationId,
        ])
        return Promise.resolve(null)
      },
    })

    await expect(
      new GetPublishedSnapshotQuery(members, publications).execute({
        trustedUserId: userId,
        publicationId,
      }),
    ).resolves.toBeNull()
    expect({ resolverCalls, readCalls }).toEqual({
      resolverCalls: 1,
      readCalls: 1,
    })
  })

  it('resolves membership, reads the product local date and active snapshot exactly once', async () => {
    let resolverCalls = 0
    let readCalls = 0
    let todayCalls = 0
    const members: WorkspaceMemberResolver = {
      ...workspaceMembers,
      resolveUser: () => {
        resolverCalls += 1
        return Promise.resolve({ spaceId, memberId, userId })
      },
    }
    const publications = publicationQueries({
      findActive: (selectedSpaceId, localDate) => {
        readCalls += 1
        expect([selectedSpaceId, localDate]).toEqual([spaceId, '2026-08-15'])
        return Promise.resolve(null)
      },
    })
    const clock: ProductClock = {
      now: () => {
        throw new Error('unexpected now')
      },
      today: (timeZone) => {
        todayCalls += 1
        expect(timeZone).toBe('Asia/Yekaterinburg')
        return '2026-08-15'
      },
    }

    await expect(
      new GetActiveMonthQuery(members, publications, clock).execute({
        trustedUserId: userId,
      }),
    ).resolves.toBeNull()
    expect({ resolverCalls, todayCalls, readCalls }).toEqual({
      resolverCalls: 1,
      todayCalls: 1,
      readCalls: 1,
    })
  })
})

function publicationQueries(
  overrides: Partial<PublicationPersistencePort>,
): PublicationPersistencePort {
  return {
    publish: () => Promise.reject(new Error('unexpected publish')),
    findPublished: () => Promise.reject(new Error('unexpected findPublished')),
    findActive: () => Promise.reject(new Error('unexpected findActive')),
    ...overrides,
  }
}
