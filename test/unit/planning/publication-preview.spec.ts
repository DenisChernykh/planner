import { createHash } from 'node:crypto'

import {
  BuildPublicationPreviewQuery,
  PUBLICATION_PREVIEW_HASH_VERSION,
  PUBLICATION_PREVIEW_SCHEMA_VERSION,
  buildPublicationPreview,
  type DraftEditorView,
  type PublicationPreview,
} from '@/modules/planning'
import {
  CALENDAR_TARGETS_FORMULA_VERSION,
  GOAL_EVALUATION_FORMULA_VERSION,
  SCORE_COVERAGE_FORMULA_VERSION,
} from '@/modules/progress'
import type { DraftGoalPersistencePort } from '@/modules/planning/application/draft-goal-persistence.port'
import {
  PlanDraftNotEditableError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from '@/modules/planning/application/planning-errors'
import type { PlanningApplication } from '@/modules/planning/application/planning-application'
import { PlanningDraftController } from '@/modules/planning/presentation/planning.controller'
import { toUserId } from '@/modules/auth/domain/user-id'
import type { WorkspaceMemberResolver } from '@/modules/workspace'
import { WorkspaceMemberNotFoundError } from '@/modules/workspace'
import { CommandValidationError } from '@/shared/application/application-command'
import { canonicalJsonStringify } from '@/shared/application/command-fingerprint'
import type { ProductClock } from '@/shared/application/product-clock'

const actorId = '11111111-1111-4111-8111-111111111111'
const otherActorId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const goalA = '44444444-4444-4444-8444-444444444444'
const goalB = '55555555-5555-4555-8555-555555555555'
const definitionA = '66666666-6666-4666-8666-666666666666'
const definitionB = '77777777-7777-4777-8777-777777777777'
const versionA = '88888888-8888-4888-8888-888888888888'
const versionB = '99999999-9999-4999-8999-999999999999'
const seriesA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const seriesB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const planMonthId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function goal(
  overrides: Partial<DraftEditorView['goals'][number]> = {},
): DraftEditorView['goals'][number] {
  return {
    planGoalId: goalA,
    goalDefinitionId: definitionA,
    goalDefinitionVersionId: versionA,
    goalSeriesId: seriesA,
    title: 'Water',
    why: 'Health',
    category: 'Body',
    displayOrder: 0,
    configRevision: 3n,
    config: {
      schemaVersion: 1,
      scope: { kind: 'personal', ownerMemberId: actorId },
      repetition: { kind: 'monthly', n: '10' },
      measurement: { kind: 'boolean' },
      checkpoints: null,
    },
    sourceProvenance: {
      schemaVersion: 1,
      sourceDocument: 'monthly-plan-template',
      sourcePage: 3,
      rawValue: '10',
      rawDenominator: '30',
      resolution: 'Ten times per month',
    },
    blockers: [],
    ...overrides,
  }
}

function editor(overrides: Partial<DraftEditorView> = {}): DraftEditorView {
  return {
    planMonthId,
    spaceId,
    targetMonth: '2026-08',
    status: 'draft',
    focus: 'First lived month',
    planMonthRevision: 2n,
    draftRevision: 7n,
    goals: [goal()],
    blockers: [],
    ...overrides,
  }
}

function stripHash(value: PublicationPreview): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'previewHash'),
  )
}

function numberedUuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`
}

function mixedMaterializationGoals(
  oneOffComponents: 4 | 5,
): DraftEditorView['goals'] {
  const checklist = (
    goalIndex: number,
    count: number,
  ): {
    kind: 'checklist'
    items: { itemId: string; label: string }[]
  } => ({
    kind: 'checklist' as const,
    items: Array.from({ length: count }, (_, itemIndex) => ({
      itemId: numberedUuid((goalIndex + 1) * 1000 + itemIndex),
      label: `Item ${goalIndex}-${itemIndex}`,
    })),
  })
  const identity = (
    goalIndex: number,
  ): Pick<
    DraftEditorView['goals'][number],
    | 'planGoalId'
    | 'goalDefinitionId'
    | 'goalDefinitionVersionId'
    | 'goalSeriesId'
    | 'displayOrder'
  > => ({
    planGoalId: numberedUuid(goalIndex + 1),
    goalDefinitionId: numberedUuid(100 + goalIndex),
    goalDefinitionVersionId: numberedUuid(200 + goalIndex),
    goalSeriesId: numberedUuid(300 + goalIndex),
    displayOrder: goalIndex,
  })
  return [
    ...[100, 100, 100, 22].map((componentCount, goalIndex) =>
      goal({
        ...identity(goalIndex),
        config: {
          ...goal().config,
          repetition: { kind: 'daily' },
          measurement: checklist(goalIndex, componentCount),
        },
      }),
    ),
    goal({
      ...identity(4),
      config: {
        ...goal().config,
        repetition: { kind: 'one_off', dueDate: '2029-12-31' },
        measurement: checklist(4, oneOffComponents),
      },
    }),
    goal({
      ...identity(5),
      config: {
        ...goal().config,
        repetition: { kind: 'weekly', n: '1' },
        measurement: { kind: 'boolean' },
      },
    }),
    goal({
      ...identity(6),
      config: {
        ...goal().config,
        repetition: { kind: 'monthly', n: '1' },
        measurement: { kind: 'boolean' },
      },
    }),
  ]
}

describe('P06 publication preview projector', () => {
  it('projects a late current monthly goal into one exact actor-free frozen target', () => {
    const value = buildPublicationPreview(editor(), '2026-08-15')

    expect(value).toMatchObject({
      schemaVersion: PUBLICATION_PREVIEW_SCHEMA_VERSION,
      planMonthId,
      spaceId,
      targetMonth: '2026-08',
      status: 'draft',
      planMonthRevision: '2',
      draftRevision: '7',
      previewHashVersion: PUBLICATION_PREVIEW_HASH_VERSION,
      activation: {
        mode: 'immediate',
        activeLocalDate: '2026-08-15',
        latePublication: true,
      },
      focus: 'First lived month',
      formulaVersions: {
        calendarTargets: CALENDAR_TARGETS_FORMULA_VERSION,
        goalEvaluation: GOAL_EVALUATION_FORMULA_VERSION,
        scoreCoverage: SCORE_COVERAGE_FORMULA_VERSION,
      },
      blockers: [],
    })
    expect(value.previewHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(value.goals).toHaveLength(1)
    expect(value.goals[0]).toMatchObject({
      planGoalId: goalA,
      configRevision: '3',
      config: {
        scope: { kind: 'personal', ownerMemberId: actorId },
        repetition: { kind: 'monthly', n: '10' },
      },
    })
    expect(value.calculatedTargets).toEqual([
      {
        planGoalId: goalA,
        formulaVersion: CALENDAR_TARGETS_FORMULA_VERSION,
        calendar: {
          targetMonth: '2026-08',
          activeLocalDate: '2026-08-15',
          timeZone: 'Asia/Yekaterinburg',
          kind: 'quota',
          cadence: 'monthly',
          periods: [
            {
              cadence: 'monthly',
              ordinal: 1,
              periodStart: '2026-08-01',
              periodEnd: '2026-08-31',
              periodDays: 31,
              activeDates: Array.from(
                { length: 17 },
                (_, index) => `2026-08-${String(index + 15).padStart(2, '0')}`,
              ),
              eligibleDates: Array.from(
                { length: 17 },
                (_, index) => `2026-08-${String(index + 15).padStart(2, '0')}`,
              ),
              periodTarget: 5,
            },
          ],
        },
      },
    ])
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.goals)).toBe(true)
    expect(Object.isFrozen(value.goals[0]!.config)).toBe(true)
    expect(Object.isFrozen(value.calculatedTargets[0]!.calendar)).toBe(true)
  })

  it('uses day one for next month and returns all weekly periods in display order', () => {
    const first = goal({
      config: {
        ...goal().config,
        repetition: { kind: 'weekly', n: '3' },
      },
    })
    const second = goal({
      planGoalId: goalB,
      goalDefinitionId: definitionB,
      goalDefinitionVersionId: versionB,
      goalSeriesId: seriesB,
      displayOrder: 1,
      configRevision: 1n,
      config: {
        ...goal().config,
        scope: { kind: 'shared' },
        repetition: { kind: 'daily' },
      },
    })
    const value = buildPublicationPreview(
      editor({ targetMonth: '2026-09', goals: [first, second] }),
      '2026-08-31',
    )

    expect(value.activation).toEqual({
      mode: 'scheduled',
      activeLocalDate: '2026-09-01',
      latePublication: false,
    })
    expect(value.calculatedTargets.map((target) => target.planGoalId)).toEqual([
      goalA,
      goalB,
    ])
    expect(value.calculatedTargets[0]).toMatchObject({
      calendar: {
        kind: 'quota',
        cadence: 'weekly',
        periods: [
          { periodStart: '2026-09-01', periodEnd: '2026-09-06' },
          { periodStart: '2026-09-07', periodEnd: '2026-09-13' },
          { periodStart: '2026-09-14', periodEnd: '2026-09-20' },
          { periodStart: '2026-09-21', periodEnd: '2026-09-27' },
          { periodStart: '2026-09-28', periodEnd: '2026-09-30' },
        ],
      },
    })
  })

  it('returns a plan-level window blocker before goal blockers for another month', () => {
    const incomplete = goal({
      config: {
        ...goal().config,
        repetition: { kind: 'monthly', n: null },
      },
      blockers: [
        {
          planGoalId: goalA,
          pointer: '/repetition/n',
          code: 'required',
          detail: 'Required value is missing.',
        },
      ],
    })
    const value = buildPublicationPreview(
      editor({ targetMonth: '2026-06', goals: [incomplete] }),
      '2026-08-15',
    )

    expect(value.activation).toEqual({
      mode: 'blocked',
      activeLocalDate: '2026-06-01',
      latePublication: false,
    })
    expect(value.calculatedTargets).toEqual([])
    expect(value.blockers).toEqual([
      {
        planGoalId: null,
        pointer: '/targetMonth',
        code: 'incompatible',
        detail: 'Target month is not current or next.',
      },
      {
        planGoalId: goalA,
        pointer: '/repetition/n',
        code: 'required',
        detail: 'Required value is missing.',
      },
    ])
  })

  it.each([
    {
      name: 'one-off date outside target month',
      targetMonth: '2026-08',
      repetition: { kind: 'one_off', dueDate: '2026-09-01' } as const,
      pointer: '/repetition/dueDate',
      detail: 'due date is outside target month',
    },
    {
      name: 'missing fifth week segment',
      targetMonth: '2027-02',
      repetition: {
        kind: 'weekly_planned_task',
        weekOrdinal: '5',
        taskText: 'Task text is display-only',
      } as const,
      pointer: '/repetition/weekOrdinal',
      detail: 'week ordinal is not present in target month',
    },
  ])('turns $name into one finite P04 blocker and no target', (fixture) => {
    const value = buildPublicationPreview(
      editor({
        targetMonth: fixture.targetMonth,
        goals: [
          goal({
            config: { ...goal().config, repetition: fixture.repetition },
          }),
        ],
      }),
      fixture.targetMonth === '2026-08' ? '2026-08-01' : '2027-01-31',
    )
    expect(value.calculatedTargets).toEqual([])
    const blocker = {
      planGoalId: goalA,
      pointer: fixture.pointer,
      code: 'incompatible',
      detail: fixture.detail,
    } as const
    expect(value.goals[0]?.blockers).toEqual([blocker])
    expect(value.blockers).toEqual([blocker])
    expect(value.goals[0]?.blockers[0]).toBe(value.blockers[0])
    expect(Object.isFrozen(value.goals[0]?.blockers)).toBe(true)
    expect(Object.isFrozen(value.goals[0]?.blockers[0])).toBe(true)
  })

  it('allows an empty draft without inventing blockers or targets', () => {
    const value = buildPublicationPreview(
      editor({ goals: [], blockers: [] }),
      '2026-08-01',
    )
    expect(value.goals).toEqual([])
    expect(value.calculatedTargets).toEqual([])
    expect(value.blockers).toEqual([])
  })

  it('counts snapshots, fixed expectations and flexible periods at the exact 10000/10001 boundary', () => {
    const boundary = buildPublicationPreview(
      editor({ targetMonth: '2029-12', goals: mixedMaterializationGoals(4) }),
      '2029-12-01',
    )
    expect(boundary.blockers).toEqual([])
    expect(boundary.goals).toHaveLength(7)
    expect(
      boundary.calculatedTargets.map(({ calendar }) =>
        calendar.kind === 'quota'
          ? `${calendar.kind}:${calendar.cadence}`
          : calendar.kind,
      ),
    ).toEqual([
      'fixed',
      'fixed',
      'fixed',
      'fixed',
      'fixed',
      'quota:weekly',
      'quota:monthly',
    ])

    const oversized = buildPublicationPreview(
      editor({ targetMonth: '2029-12', goals: mixedMaterializationGoals(5) }),
      '2029-12-01',
    )
    expect(oversized.goals).toHaveLength(7)
    expect(oversized.calculatedTargets).toHaveLength(7)
    expect(oversized.goals.every((item) => item.blockers.length === 0)).toBe(
      true,
    )
    expect(oversized.blockers).toEqual([
      {
        planGoalId: null,
        pointer: '/goals',
        code: 'incompatible',
        detail: 'Publication materialization exceeds 10000 rows.',
      },
    ])
    expect(oversized.previewHash).toBe(
      createHash('sha256')
        .update(canonicalJsonStringify(stripHash(oversized) as never), 'utf8')
        .digest('hex'),
    )
  })

  it('sorts two plan-level blockers by pointer before hashing the combined wrong-window and oversized preview', () => {
    // Returning zero for two null goal IDs must not leave insertion order in the hash.
    const value = buildPublicationPreview(
      editor({ targetMonth: '2029-12', goals: mixedMaterializationGoals(5) }),
      '2029-10-01',
    )
    const expectedBlockers = [
      {
        planGoalId: null,
        pointer: '/goals',
        code: 'incompatible',
        detail: 'Publication materialization exceeds 10000 rows.',
      },
      {
        planGoalId: null,
        pointer: '/targetMonth',
        code: 'incompatible',
        detail: 'Target month is not current or next.',
      },
    ]
    expect(value.blockers).toEqual(expectedBlockers)
    expect(canonicalJsonStringify(stripHash(value) as never)).toContain(
      '"blockers":[{"code":"incompatible","detail":"Publication materialization exceeds 10000 rows.","planGoalId":null,"pointer":"/goals"},{"code":"incompatible","detail":"Target month is not current or next.","planGoalId":null,"pointer":"/targetMonth"}]',
    )
    expect(value.previewHash).toBe(
      'abf78617a87c35e5f367d38ff29cd22ab8f76d657001867927270a23ec11a9b7',
    )
  })

  it('is byte/hash stable, actor-independent and changes with revision, config, provenance, order, blocker or date', () => {
    const original = buildPublicationPreview(editor(), '2026-08-15')
    const repeated = buildPublicationPreview(editor(), '2026-08-15')
    expect(JSON.stringify(repeated)).toBe(JSON.stringify(original))
    expect(repeated.previewHash).toBe(original.previewHash)
    expect(original.previewHash).toBe(
      createHash('sha256')
        .update(canonicalJsonStringify(stripHash(original) as never), 'utf8')
        .digest('hex'),
    )

    const changes: PublicationPreview[] = [
      buildPublicationPreview(editor({ draftRevision: 8n }), '2026-08-15'),
      buildPublicationPreview(
        editor({ goals: [goal({ title: 'Changed' })] }),
        '2026-08-15',
      ),
      buildPublicationPreview(
        editor({ goals: [goal({ sourceProvenance: null })] }),
        '2026-08-15',
      ),
      buildPublicationPreview(
        editor({
          goals: [
            goal({ displayOrder: 1 }),
            goal({
              planGoalId: goalB,
              goalDefinitionId: definitionB,
              goalDefinitionVersionId: versionB,
              goalSeriesId: seriesB,
              displayOrder: 0,
            }),
          ],
        }),
        '2026-08-15',
      ),
      buildPublicationPreview(
        editor({
          goals: [
            goal({
              config: {
                ...goal().config,
                repetition: { kind: 'monthly', n: null },
              },
            }),
          ],
        }),
        '2026-08-15',
      ),
      buildPublicationPreview(editor(), '2026-08-16'),
    ]
    for (const changed of changes) {
      expect(changed.previewHash).not.toBe(original.previewHash)
    }
  })

  it('detaches the result from the editor and never reads actor/profile data', () => {
    const source = editor()
    const value = buildPublicationPreview(source, '2026-08-15')
    expect(Object.isFrozen(source.goals[0]!.config)).toBe(false)
    expect(Object.isFrozen(source.goals[0]!.sourceProvenance!)).toBe(false)
    ;(
      source.goals[0]!.config.repetition as {
        kind: 'monthly'
        n: string | null
      }
    ).n = '99'
    ;(source.goals[0]!.sourceProvenance as { resolution: string }).resolution =
      'Mutated provenance'
    ;(source.goals as DraftEditorView['goals'][number][])[0] = goal({
      title: 'Mutated outside',
    })
    expect(value.goals[0]?.title).toBe('Water')
    expect(value.goals[0]?.config.repetition).toEqual({
      kind: 'monthly',
      n: '10',
    })
    expect(value.goals[0]?.sourceProvenance?.resolution).toBe(
      'Ten times per month',
    )
    expect(JSON.stringify(value)).not.toContain(otherActorId)
  })

  it('derives each goal and aggregate P03 blocker from the same validation result', () => {
    const falseInputBlocker = {
      planGoalId: goalA,
      pointer: '/measurement',
      code: 'incompatible' as const,
      detail: 'Values are incompatible.',
    }
    const valid = buildPublicationPreview(
      editor({ goals: [goal({ blockers: [falseInputBlocker] })] }),
      '2026-08-15',
    )
    expect(valid.goals[0]?.blockers).toEqual([])
    expect(valid.blockers).toEqual([])

    const staleMissing = buildPublicationPreview(
      editor({
        goals: [
          goal({
            blockers: [],
            config: {
              ...goal().config,
              repetition: { kind: 'monthly', n: null },
            },
          }),
        ],
      }),
      '2026-08-15',
    )
    expect(staleMissing.goals[0]?.blockers).toEqual([
      {
        planGoalId: goalA,
        pointer: '/repetition/n',
        code: 'required',
        detail: 'Required value is missing.',
      },
    ])
    expect(staleMissing.blockers).toEqual(staleMissing.goals[0]?.blockers)
  })
})

describe('P06 bounded preview query', () => {
  function queryFixture(
    options: {
      readonly draft?: DraftEditorView | null
      readonly resolveError?: Error
      readonly readError?: Error
    } = {},
  ): {
    readonly query: BuildPublicationPreviewQuery
    readonly resolveUser: jest.Mock
    readonly resolveMember: jest.Mock
    readonly findEditor: jest.Mock
    readonly today: jest.Mock
  } {
    const resolveUser = jest.fn(() =>
      options.resolveError === undefined
        ? Promise.resolve({ userId: otherActorId, memberId: actorId, spaceId })
        : Promise.reject(options.resolveError),
    )
    const resolveMember = jest.fn(() =>
      Promise.resolve({ userId: otherActorId, memberId: actorId, spaceId }),
    )
    const findEditor = jest.fn(() =>
      options.readError === undefined
        ? Promise.resolve(
            options.draft === undefined ? editor() : options.draft,
          )
        : Promise.reject(options.readError),
    )
    const today = jest.fn(() => '2026-08-15')
    const workspaceMembers = {
      resolveMember,
      resolveUser,
      resolveTelegramId: jest.fn(),
    } satisfies WorkspaceMemberResolver
    const drafts = {
      findEditor,
      add: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      reorder: jest.fn(),
    } satisfies DraftGoalPersistencePort
    const clock = {
      today,
      now: jest.fn(() => new Date('2026-08-15T00:00:00.000Z')),
    } satisfies ProductClock
    return {
      query: new BuildPublicationPreviewQuery(workspaceMembers, drafts, clock),
      resolveUser,
      resolveMember,
      findEditor,
      today,
    }
  }

  it('snapshots input, resolves member, reads clock/editor exactly once and returns null for missing draft', async () => {
    const fixture = queryFixture({ draft: null })
    await expect(
      fixture.query.execute({
        trustedUserId: otherActorId,
        targetMonth: '2026-08',
      }),
    ).resolves.toBeNull()
    expect(fixture.resolveUser).toHaveBeenCalledTimes(1)
    expect(fixture.resolveUser).toHaveBeenCalledWith(otherActorId)
    expect(fixture.resolveMember).not.toHaveBeenCalled()
    expect(fixture.today).toHaveBeenCalledTimes(1)
    expect(fixture.today).toHaveBeenCalledWith('Asia/Yekaterinburg')
    expect(fixture.findEditor).toHaveBeenCalledTimes(1)
    expect(fixture.findEditor).toHaveBeenCalledWith(spaceId, '2026-08')
  })

  it('returns the same actor-free preview for either authorized member', async () => {
    const first = queryFixture()
    const second = queryFixture()
    await expect(
      first.query.execute({
        trustedUserId: actorId,
        targetMonth: '2026-08',
      }),
    ).resolves.toEqual(
      await second.query.execute({
        trustedUserId: otherActorId,
        targetMonth: '2026-08',
      }),
    )
  })

  it.each([
    [{ trustedUserId: actorId }, CommandValidationError],
    [
      {
        trustedUserId: actorId,
        targetMonth: '2026-13',
      },
      CommandValidationError,
    ],
    [
      {
        trustedUserId: 'not-a-uuid',
        targetMonth: '2026-08',
      },
      CommandValidationError,
    ],
    [
      {
        trustedUserId: actorId,
        targetMonth: '2026-08',
        extra: true,
      },
      CommandValidationError,
    ],
  ])(
    'preserves finite input/authorization error for %p',
    async (input, error) => {
      const fixture = queryFixture()
      await expect(
        fixture.query.execute(input as never),
      ).rejects.toBeInstanceOf(error)
      expect(fixture.today).not.toHaveBeenCalled()
      expect(fixture.findEditor).not.toHaveBeenCalled()
    },
  )

  it('maps member/read failures to dependency but preserves finite not-editable', async () => {
    await expect(
      queryFixture({ resolveError: new Error('member db') }).query.execute({
        trustedUserId: actorId,
        targetMonth: '2026-08',
      }),
    ).rejects.toBeInstanceOf(PlanningDependencyUnavailableError)
    await expect(
      queryFixture({
        resolveError: new WorkspaceMemberNotFoundError(),
      }).query.execute({
        trustedUserId: actorId,
        targetMonth: '2026-08',
      }),
    ).rejects.toBeInstanceOf(PlanningAuthorizationDeniedError)
    await expect(
      queryFixture({ readError: new Error('draft db') }).query.execute({
        trustedUserId: actorId,
        targetMonth: '2026-08',
      }),
    ).rejects.toBeInstanceOf(PlanningDependencyUnavailableError)
    await expect(
      queryFixture({
        readError: new PlanDraftNotEditableError(),
      }).query.execute({
        trustedUserId: actorId,
        targetMonth: '2026-08',
      }),
    ).rejects.toBeInstanceOf(PlanDraftNotEditableError)
  })
})

describe('P06 HTTP/application identity boundary', () => {
  it('passes the trusted session user directly and performs no controller membership lookup', async () => {
    const preview = buildPublicationPreview(editor(), '2026-08-15')
    const execute = jest.fn(() => Promise.resolve(preview))
    const resolveUser = jest.fn(() =>
      Promise.resolve({ userId: otherActorId, memberId: actorId, spaceId }),
    )
    const controller = new PlanningDraftController(
      {
        buildPublicationPreview: { execute },
      } as unknown as PlanningApplication,
      {
        resolveUser,
        resolveMember: jest.fn(),
        resolveTelegramId: jest.fn(),
      },
    )

    await expect(
      controller.publicationPreview(
        { userId: toUserId(otherActorId), sessionId: 'session-id' },
        { targetMonth: '2026-08' },
      ),
    ).resolves.toBe(preview)
    expect(resolveUser).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith({
      trustedUserId: otherActorId,
      targetMonth: '2026-08',
    })
  })
})
