import { CommandValidationError } from '@/shared/application/application-command'
import {
  canonicalArchiveGoalDefinitionPayload,
  canonicalCopyGoalDefinitionPayload,
  canonicalCreateGoalDefinitionPayload,
  canonicalCreateGoalDefinitionVersionPayload,
  snapshotArchiveGoalDefinitionCommand,
  snapshotCopyGoalDefinitionCommand,
  snapshotCreateGoalDefinitionCommand,
  snapshotCreateGoalDefinitionVersionCommand,
  snapshotGoalDefinitionListInput,
  snapshotRestoreGoalDefinitionCommand,
} from '@/modules/planning/application/goal-catalog.validation'
import {
  ARCHIVE_GOAL_DEFINITION,
  COPY_GOAL_DEFINITION,
  CREATE_GOAL_DEFINITION,
  CREATE_GOAL_DEFINITION_VERSION,
  RESTORE_GOAL_DEFINITION,
} from '@/modules/planning/application/goal-catalog.commands'
import type { GoalCatalogPersistencePort } from '@/modules/planning/application/goal-catalog-persistence.port'
import {
  GetGoalDefinitionQuery,
  ListGoalDefinitionsQuery,
} from '@/modules/planning/application/goal-catalog.queries'
import { PlanningAuthorizationDeniedError } from '@/modules/planning/application/planning-errors'
import { PrismaGoalCatalogPersistence } from '@/modules/planning/infrastructure/prisma-goal-catalog.persistence'
import { WorkspaceMemberNotFoundError } from '@/modules/workspace/application/workspace-errors'
import {
  toGoalDefinitionDetailResponse,
  toGoalDefinitionResultResponse,
  toGoalDefinitionSummaryResponse,
} from '@/modules/planning/presentation/goal-catalog.response'

const commandId = '11111111-1111-4111-8111-111111111111'
const actorId = '22222222-2222-4222-8222-222222222222'
const definitionId = '33333333-3333-4333-8333-333333333333'
const versionId = '44444444-4444-4444-8444-444444444444'
const seriesId = '55555555-5555-4555-8555-555555555555'

function actor(): { readonly kind: 'member'; readonly id: string } {
  return { kind: 'member', id: actorId }
}

describe('P02 goal catalog contract', () => {
  it('snapshots every primitive exactly once before command execution', () => {
    const reads = new Map<string, number>()
    const once =
      <T>(name: string, value: T): (() => T) =>
      () => {
        reads.set(name, (reads.get(name) ?? 0) + 1)
        return value
      }
    const payload = Object.defineProperties(
      {},
      {
        goalDefinitionId: {
          enumerable: true,
          get: once('goalDefinitionId', definitionId),
        },
        title: { enumerable: true, get: once('title', '  Сон 🌙  ') },
        why: { enumerable: true, get: once('why', 'Не менять байты') },
        category: { enumerable: true, get: once('category', 'Здоровье') },
        seriesDecision: {
          enumerable: true,
          get: once('seriesDecision', 'continue'),
        },
      },
    )
    const command = Object.defineProperties(
      {},
      {
        commandId: { enumerable: true, get: once('commandId', commandId) },
        trustedActor: {
          enumerable: true,
          get: once('trustedActor', actor()),
        },
        expectedRevision: {
          enumerable: true,
          get: once('expectedRevision', 7n),
        },
        payload: { enumerable: true, get: once('payload', payload) },
      },
    )

    expect(snapshotCreateGoalDefinitionVersionCommand(command)).toEqual({
      commandId,
      trustedActor: actor(),
      expectedRevision: 7n,
      payload: {
        goalDefinitionId: definitionId,
        title: '  Сон 🌙  ',
        why: 'Не менять байты',
        category: 'Здоровье',
        seriesDecision: 'continue',
      },
    })
    expect(Object.fromEntries(reads)).toEqual({
      commandId: 1,
      trustedActor: 1,
      expectedRevision: 1,
      payload: 1,
      goalDefinitionId: 1,
      title: 1,
      why: 1,
      category: 1,
      seriesDecision: 1,
    })
  })

  it('preserves exact metadata bytes and counts Unicode code points', () => {
    const valid = [
      { title: ' x ', why: '\u00e9\u0065\u0301', category: '\tcat\n' },
      {
        title: '🌙'.repeat(200),
        why: 'я'.repeat(2_000),
        category: '🧭'.repeat(100),
      },
    ]
    for (const payload of valid) {
      expect(canonicalCreateGoalDefinitionPayload(payload)).toEqual(payload)
    }

    for (const payload of [
      { title: '', why: 'why', category: 'cat' },
      { title: ' \n\t ', why: 'why', category: 'cat' },
      { title: 'x'.repeat(201), why: 'why', category: 'cat' },
      { title: 'title', why: 'x'.repeat(2_001), category: 'cat' },
      { title: 'title', why: 'why', category: 'x'.repeat(101) },
      { title: new String('title'), why: 'why', category: 'cat' },
    ]) {
      expect(() =>
        canonicalCreateGoalDefinitionPayload(payload as never),
      ).toThrow(CommandValidationError)
    }
  })

  it('rejects missing or invalid series decisions and exact-payload violations', () => {
    const base = {
      goalDefinitionId: definitionId,
      title: 'Сон',
      why: 'Восстановление',
      category: 'Здоровье',
    }
    for (const payload of [
      base,
      { ...base, seriesDecision: 'automatic' },
      { ...base, seriesDecision: 'new', memberId: actorId },
      Object.assign(Object.create(null), { ...base, seriesDecision: 'new' }),
    ]) {
      expect(() =>
        canonicalCreateGoalDefinitionVersionPayload(payload as never),
      ).toThrow(CommandValidationError)
    }
    expect(
      canonicalCreateGoalDefinitionVersionPayload({
        ...base,
        seriesDecision: 'new',
      }),
    ).toEqual({ ...base, seriesDecision: 'new' })
  })

  it('enforces absent create revision and positive CAS revisions for every other mutation', () => {
    expect(
      snapshotCreateGoalDefinitionCommand({
        commandId,
        trustedActor: actor(),
        payload: { title: 'Сон', why: 'Зачем', category: 'Здоровье' },
      }),
    ).toEqual({
      commandId,
      trustedActor: actor(),
      payload: { title: 'Сон', why: 'Зачем', category: 'Здоровье' },
    })
    expect(() =>
      snapshotCreateGoalDefinitionCommand({
        commandId,
        trustedActor: actor(),
        expectedRevision: 1n,
        payload: { title: 'Сон', why: 'Зачем', category: 'Здоровье' },
      }),
    ).toThrow(CommandValidationError)

    const snapshots = [
      snapshotArchiveGoalDefinitionCommand,
      snapshotRestoreGoalDefinitionCommand,
      snapshotCopyGoalDefinitionCommand,
    ] as const
    for (const snapshot of snapshots) {
      for (const expectedRevision of [undefined, 0n, -1n, '1']) {
        expect(() =>
          snapshot({
            commandId,
            trustedActor: actor(),
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            payload:
              snapshot === snapshotCopyGoalDefinitionCommand
                ? { sourceGoalDefinitionId: definitionId }
                : { goalDefinitionId: definitionId },
          }),
        ).toThrow(CommandValidationError)
      }
    }
  })

  it('projects exact canonical payloads and locked command definitions', () => {
    expect(
      canonicalCreateGoalDefinitionPayload({
        title: 'Сон',
        why: 'Зачем',
        category: 'Здоровье',
      }),
    ).toEqual({ category: 'Здоровье', title: 'Сон', why: 'Зачем' })
    expect(
      canonicalArchiveGoalDefinitionPayload({ goalDefinitionId: definitionId }),
    ).toEqual({ goalDefinitionId: definitionId })
    expect(
      canonicalCopyGoalDefinitionPayload({
        sourceGoalDefinitionId: definitionId,
      }),
    ).toEqual({ sourceGoalDefinitionId: definitionId })
    expect([
      CREATE_GOAL_DEFINITION,
      CREATE_GOAL_DEFINITION_VERSION,
      ARCHIVE_GOAL_DEFINITION,
      RESTORE_GOAL_DEFINITION,
      COPY_GOAL_DEFINITION,
    ]).toEqual([
      expect.objectContaining({
        commandType: 'planning.create-goal-definition.v1',
        resultKind: 'planning.goal-definition.v1',
      }),
      expect.objectContaining({
        commandType: 'planning.create-goal-definition-version.v1',
        resultKind: 'planning.goal-definition.v1',
      }),
      expect.objectContaining({
        commandType: 'planning.archive-goal-definition.v1',
        resultKind: 'planning.goal-definition.v1',
      }),
      expect.objectContaining({
        commandType: 'planning.restore-goal-definition.v1',
        resultKind: 'planning.goal-definition.v1',
      }),
      expect.objectContaining({
        commandType: 'planning.copy-goal-definition.v1',
        resultKind: 'planning.goal-definition.v1',
      }),
    ])
  })

  it('defaults list state to active and rejects invalid/extra query keys', () => {
    expect(snapshotGoalDefinitionListInput({ trustedActor: actor() })).toEqual({
      trustedActor: actor(),
      state: 'active',
    })
    expect(
      snapshotGoalDefinitionListInput({ trustedActor: actor(), state: 'all' }),
    ).toEqual({ trustedActor: actor(), state: 'all' })
    for (const input of [
      { trustedActor: actor(), state: 'deleted' },
      { trustedActor: actor(), state: 'active', userId: actorId },
    ]) {
      expect(() => snapshotGoalDefinitionListInput(input as never)).toThrow(
        CommandValidationError,
      )
    }
  })

  it('preserves CommandValidationError at the public query boundary', async () => {
    const query = new ListGoalDefinitionsQuery({} as never, {} as never)
    await expect(
      query.execute({ trustedActor: actor(), state: 'deleted' as never }),
    ).rejects.toBeInstanceOf(CommandValidationError)
  })

  it('derives query scope from the member resolver and never reaches persistence for denied actors', async () => {
    const resolved: string[] = []
    const reads: string[] = []
    const resolver = {
      resolveMember(memberId: string) {
        resolved.push(memberId)
        if (memberId === actorId) {
          return Promise.resolve({
            memberId,
            spaceId: '66666666-6666-4666-8666-666666666666',
            userId: '77777777-7777-4777-8777-777777777777',
          })
        }
        throw new WorkspaceMemberNotFoundError()
      },
    } as never
    const catalog = {
      list(spaceId: string, state: string) {
        reads.push(`list:${spaceId}:${state}`)
        return Promise.resolve([])
      },
      get(spaceId: string, id: string) {
        reads.push(`get:${spaceId}:${id}`)
        return Promise.resolve(null)
      },
    } as unknown as GoalCatalogPersistencePort
    const list = new ListGoalDefinitionsQuery(resolver, catalog)
    const get = new GetGoalDefinitionQuery(resolver, catalog)

    await expect(list.execute({ trustedActor: actor() })).resolves.toEqual([])
    await expect(
      get.execute({ trustedActor: actor(), goalDefinitionId: definitionId }),
    ).resolves.toBeNull()
    expect(resolved).toEqual([actorId, actorId])
    expect(reads).toEqual([
      'list:66666666-6666-4666-8666-666666666666:active',
      `get:66666666-6666-4666-8666-666666666666:${definitionId}`,
    ])

    const beforeDeniedReads = [...reads]
    await expect(
      list.execute({
        trustedActor: { kind: 'system', id: 'planner-worker' },
      }),
    ).rejects.toBeInstanceOf(PlanningAuthorizationDeniedError)
    await expect(
      get.execute({
        trustedActor: {
          kind: 'member',
          id: '88888888-8888-4888-8888-888888888888',
        },
        goalDefinitionId: definitionId,
      }),
    ).rejects.toBeInstanceOf(PlanningAuthorizationDeniedError)
    expect(reads).toEqual(beforeDeniedReads)
  })

  it('reads detail in one database statement and recursively freezes one consistent view graph', async () => {
    let queries = 0
    const rows = [
      {
        goal_definition_id: definitionId,
        state: 'active',
        revision: 2n,
        version_id: versionId,
        version_number: 2n,
        series_id: seriesId,
        series_decision: 'continue',
        title: 'Сон 2',
        why: 'Восстановление 2',
        category: 'Здоровье',
      },
      {
        goal_definition_id: definitionId,
        state: 'active',
        revision: 2n,
        version_id: '99999999-9999-4999-8999-999999999999',
        version_number: 1n,
        series_id: seriesId,
        series_decision: 'new',
        title: 'Сон 1',
        why: 'Восстановление 1',
        category: 'Здоровье',
      },
    ]
    const client = {
      $queryRaw(): Promise<typeof rows> {
        queries += 1
        return Promise.resolve(rows)
      },
    }
    const persistence = new PrismaGoalCatalogPersistence({
      withClient<T>(effect: (value: typeof client) => Promise<T>): Promise<T> {
        return effect(client)
      },
    } as never)

    const detail = await persistence.get(
      '66666666-6666-4666-8666-666666666666',
      definitionId,
    )
    expect(queries).toBe(1)
    expect(detail?.currentVersion).toBe(detail?.versions[0])
    expect(detail).toMatchObject({
      revision: 2n,
      currentVersion: { versionNumber: 2n },
      versions: [{ versionNumber: 2n }, { versionNumber: 1n }],
    })
    expect(Object.isFrozen(detail)).toBe(true)
    expect(Object.isFrozen(detail?.versions)).toBe(true)
    expect(Object.isFrozen(detail?.currentVersion)).toBe(true)
    expect(detail?.versions.every(Object.isFrozen)).toBe(true)
    expect(() => {
      ;(detail as { state: string }).state = 'archived'
    }).toThrow(TypeError)
    expect(() => {
      ;(detail?.versions as unknown[]).push({})
    }).toThrow(TypeError)
  })

  it('recursively freezes list arrays, summaries and current versions', async () => {
    const rows = [
      {
        goal_definition_id: definitionId,
        state: 'active',
        revision: 1n,
        version_id: versionId,
        version_number: 1n,
        series_id: seriesId,
        series_decision: 'new',
        title: 'Сон',
        why: 'Восстановление',
        category: 'Здоровье',
        created_at: new Date('2026-03-02T03:04:05.678Z'),
      },
    ]
    const client = { $queryRaw: () => Promise.resolve(rows) }
    const persistence = new PrismaGoalCatalogPersistence({
      withClient<T>(effect: (value: typeof client) => Promise<T>): Promise<T> {
        return effect(client)
      },
    } as never)

    const values = await persistence.list(
      '66666666-6666-4666-8666-666666666666',
      'active',
    )
    expect(Object.isFrozen(values)).toBe(true)
    expect(Object.isFrozen(values[0])).toBe(true)
    expect(Object.isFrozen(values[0]?.currentVersion)).toBe(true)
    expect(() => {
      ;(values as unknown[]).push({})
    }).toThrow(TypeError)
    expect(() => {
      ;(values[0] as { revision: bigint }).revision = 2n
    }).toThrow(TypeError)
  })

  it('serializes exact result and views with positive decimal bigint strings', () => {
    const currentVersion = {
      goalDefinitionVersionId: versionId,
      versionNumber: 2n,
      goalSeriesId: seriesId,
      seriesDecision: 'continue' as const,
      title: 'Сон',
      why: 'Восстановление',
      category: 'Здоровье',
    }
    expect(
      toGoalDefinitionResultResponse({
        kind: 'planning.goal-definition.v1',
        aggregateId: definitionId,
        aggregateRevision: 9n,
      }),
    ).toEqual({
      kind: 'planning.goal-definition.v1',
      aggregateId: definitionId,
      aggregateRevision: '9',
    })
    expect(
      toGoalDefinitionSummaryResponse({
        goalDefinitionId: definitionId,
        state: 'active',
        revision: 2n,
        currentVersion,
      }),
    ).toEqual({
      goalDefinitionId: definitionId,
      state: 'active',
      revision: '2',
      currentVersion: {
        ...currentVersion,
        versionNumber: '2',
      },
    })
    expect(
      toGoalDefinitionDetailResponse({
        goalDefinitionId: definitionId,
        state: 'active',
        revision: 2n,
        currentVersion,
        versions: [currentVersion, { ...currentVersion, versionNumber: 1n }],
      }),
    ).toMatchObject({
      revision: '2',
      versions: [{ versionNumber: '2' }, { versionNumber: '1' }],
    })
  })
})
