import type { PublicationPreview } from '@/modules/planning'
import { buildPublicationMaterialization } from '@/modules/planning/domain/publication-builder'

const publicationId = '11111111-1111-4111-8111-111111111111'
const publisherId = '22222222-2222-4222-8222-222222222222'
const planMonthId = '33333333-3333-4333-8333-333333333333'
const spaceId = '44444444-4444-4444-8444-444444444444'
const checklistGoalId = '55555555-5555-4555-8555-555555555555'
const quotaGoalId = '66666666-6666-4666-8666-666666666666'
const checklistDefinitionId = '77777777-7777-4777-8777-777777777777'
const quotaDefinitionId = '88888888-8888-4888-8888-888888888888'
const checklistVersionId = '99999999-9999-4999-8999-999999999999'
const quotaVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const checklistSeriesId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const quotaSeriesId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const firstItemId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const secondItemId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const checklistRevisionId = 'f0000000-0000-4000-8000-000000000001'
const quotaRevisionId = 'f0000000-0000-4000-8000-000000000002'

const sourceRevisions = new Map([
  [checklistGoalId, checklistRevisionId],
  [quotaGoalId, quotaRevisionId],
])

function preview(): PublicationPreview {
  return {
    schemaVersion: 'planner.publication-preview.v1',
    planMonthId,
    spaceId,
    targetMonth: '2026-08',
    status: 'draft',
    planMonthRevision: '4',
    draftRevision: '9',
    previewHashVersion: 'planner.publication-preview-hash.v1',
    previewHash: 'ab'.repeat(32),
    activation: {
      mode: 'immediate',
      activeLocalDate: '2026-08-15',
      latePublication: true,
    },
    focus: 'Publish exactly once',
    goals: [
      {
        planGoalId: checklistGoalId,
        goalDefinitionId: checklistDefinitionId,
        goalDefinitionVersionId: checklistVersionId,
        goalSeriesId: checklistSeriesId,
        title: 'Checklist',
        why: 'Exact coverage',
        category: 'Test',
        displayOrder: 0,
        configRevision: '3',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: publisherId },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'checklist',
            items: [
              { itemId: firstItemId, label: 'First' },
              { itemId: secondItemId, label: 'Second' },
            ],
          },
          checkpoints: null,
        },
        sourceProvenance: {
          schemaVersion: 1,
          sourceDocument: 'monthly-plan-template',
          sourcePage: 3,
          rawValue: '2',
          rawDenominator: '31',
          resolution: 'Two stable items',
        },
        blockers: [],
      },
      {
        planGoalId: quotaGoalId,
        goalDefinitionId: quotaDefinitionId,
        goalDefinitionVersionId: quotaVersionId,
        goalSeriesId: quotaSeriesId,
        title: 'Weekly quota',
        why: 'Preserve zero periods',
        category: 'Test',
        displayOrder: 1,
        configRevision: '1',
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: { kind: 'weekly', n: '3' },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
        sourceProvenance: null,
        blockers: [],
      },
    ],
    calculatedTargets: [
      {
        planGoalId: checklistGoalId,
        formulaVersion: 'planner.calendar-targets.v1',
        calendar: {
          targetMonth: '2026-08',
          activeLocalDate: '2026-08-15',
          timeZone: 'Asia/Yekaterinburg',
          kind: 'fixed',
          expectationDates: ['2026-08-15', '2026-08-16'],
        },
      },
      {
        planGoalId: quotaGoalId,
        formulaVersion: 'planner.calendar-targets.v1',
        calendar: {
          targetMonth: '2026-08',
          activeLocalDate: '2026-08-15',
          timeZone: 'Asia/Yekaterinburg',
          kind: 'quota',
          cadence: 'weekly',
          periods: [
            {
              cadence: 'weekly',
              ordinal: 1,
              periodStart: '2026-08-01',
              periodEnd: '2026-08-02',
              periodDays: 7,
              activeDates: [],
              eligibleDates: [],
              periodTarget: 0,
            },
            {
              cadence: 'weekly',
              ordinal: 3,
              periodStart: '2026-08-10',
              periodEnd: '2026-08-16',
              periodDays: 7,
              activeDates: ['2026-08-15', '2026-08-16'],
              eligibleDates: ['2026-08-15', '2026-08-16'],
              periodTarget: 1,
            },
          ],
        },
      },
    ],
    blockers: [],
    formulaVersions: {
      calendarTargets: 'planner.calendar-targets.v1',
      goalEvaluation: 'planner.goal-evaluation.v1',
      scoreCoverage: 'planner.score-coverage.v1',
    },
  }
}

function builder(): typeof buildPublicationMaterialization {
  return buildPublicationMaterialization
}

describe('P07 publication materialization builder', () => {
  it('copies the confirmed preview into a detached frozen published snapshot without a second hash', () => {
    const ids = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000005',
      '10000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000007',
    ]
    const build = builder()
    const input = preview()
    const value = build(input, {
      publicationId,
      publicationRevision: 1n,
      publishedByMemberId: publisherId,
      occurredAt: new Date('2026-08-14T19:00:00.000Z'),
      sourceRevisionIdByPlanGoalId: sourceRevisions,
      nextId: () => ids.shift()!,
    })

    expect(value.snapshot).toMatchObject({
      schemaVersion: 'planner.published-snapshot.v1',
      publicationId,
      publicationRevision: '1',
      planMonthId,
      spaceId,
      targetMonth: '2026-08',
      sourcePlanMonthRevision: '4',
      sourceDraftRevision: '9',
      sourcePreviewSchemaVersion: 'planner.publication-preview.v1',
      publicationSnapshotHashVersion: 'planner.publication-preview-hash.v1',
      publicationSnapshotHash: 'ab'.repeat(32),
      focus: 'Publish exactly once',
      activation: {
        mode: 'immediate',
        activeLocalDate: '2026-08-15',
        latePublication: true,
      },
      formulaVersions: preview().formulaVersions,
    })
    expect(value.snapshot).not.toHaveProperty('publishedAt')
    expect(value.snapshot).not.toHaveProperty('publishedByMemberId')
    expect(Object.isFrozen(value.snapshot)).toBe(true)
    expect(Object.isFrozen(value.goalSnapshots[0]?.['config'])).toBe(true)

    ;(
      input.goals[0]!.config.measurement as unknown as {
        items: { label: string | null }[]
      }
    ).items[0]!.label = 'mutated'
    expect(
      (
        value.goalSnapshots[0]?.['config'] as {
          measurement: { items: readonly { label: string }[] }
        }
      ).measurement.items[0]!.label,
    ).toBe('First')
  })

  it('expands checklist fixed dates and preserves target-zero quota periods without physical not_applicable rows', () => {
    let ordinal = 0
    const build = builder()
    const value = build(preview(), {
      publicationId,
      publicationRevision: 1n,
      publishedByMemberId: publisherId,
      occurredAt: new Date('2026-08-14T19:00:00.000Z'),
      sourceRevisionIdByPlanGoalId: sourceRevisions,
      nextId: () =>
        `10000000-0000-4000-8000-${String(++ordinal).padStart(12, '0')}`,
    })

    expect(
      value.fixedExpectations.map((row) => ({
        date: row['expectationDate'],
        kind: row['componentKind'],
        id: row['componentId'],
      })),
    ).toEqual([
      { date: '2026-08-15', kind: 'checklist_item', id: firstItemId },
      { date: '2026-08-15', kind: 'checklist_item', id: secondItemId },
      { date: '2026-08-16', kind: 'checklist_item', id: firstItemId },
      { date: '2026-08-16', kind: 'checklist_item', id: secondItemId },
    ])
    expect(value.fixedExpectations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ expectationDate: '2026-08-14' }),
      ]),
    )
    expect(value.flexiblePeriods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          periodKind: 'weekly',
          ordinal: 1,
          periodTarget: 0,
          activeDates: [],
          eligibleDates: [],
        }),
      ]),
    )
    expect(value.fixedExpectations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'not_applicable' }),
      ]),
    )
  })

  it('uses the locked component matrix and never invents a preactivation weekly-task row', () => {
    const build = builder()
    const buildOne = (
      config: Record<string, unknown>,
      calendar: PublicationPreview['calculatedTargets'][number]['calendar'],
    ): ReturnType<typeof build> => {
      const input = structuredClone(preview()) as unknown as {
        goals: Record<string, unknown>[]
        calculatedTargets: Record<string, unknown>[]
      }
      input.goals = [{ ...input.goals[0]!, config }]
      input.calculatedTargets = [{ ...input.calculatedTargets[0]!, calendar }]
      let ordinal = 0
      return build(input as unknown as PublicationPreview, {
        publicationId,
        publicationRevision: 1n,
        publishedByMemberId: publisherId,
        occurredAt: new Date('2026-08-14T19:00:00.000Z'),
        sourceRevisionIdByPlanGoalId: new Map([
          [checklistGoalId, checklistRevisionId],
        ]),
        nextId: () =>
          `20000000-0000-4000-8000-${String(++ordinal).padStart(12, '0')}`,
      })
    }
    const baseConfig = preview().goals[0]!.config
    const fixedCalendar = preview().calculatedTargets[0]!.calendar
    const checkpointOne = '30000000-0000-4000-8000-000000000001'
    const checkpointTwo = '30000000-0000-4000-8000-000000000002'

    const scalar = buildOne(
      { ...baseConfig, measurement: { kind: 'boolean' }, checkpoints: null },
      fixedCalendar,
    )
    const anyOf = buildOne(
      {
        ...baseConfig,
        measurement: {
          kind: 'any_of',
          variants: [
            {
              variantId: firstItemId,
              label: 'One',
              unit: 'times',
              precision: 0,
              target: '1',
            },
          ],
        },
        checkpoints: null,
      },
      fixedCalendar,
    )
    const checklist = buildOne(baseConfig, fixedCalendar)
    const checkpoints = buildOne(
      {
        ...baseConfig,
        checkpoints: {
          aggregation: 'all',
          items: [
            {
              checkpointId: checkpointOne,
              name: 'Checklist checkpoint',
              deadline: '12:00',
              satisfaction: { kind: 'checklist' },
            },
            {
              checkpointId: checkpointTwo,
              name: 'Second checklist checkpoint',
              deadline: '18:00',
              satisfaction: { kind: 'checklist' },
            },
          ],
        },
      },
      fixedCalendar,
    )
    const preactivationWeeklyTask = buildOne(
      {
        ...baseConfig,
        repetition: {
          kind: 'weekly_planned_task',
          weekOrdinal: '1',
          taskText: 'Plan only after activation',
        },
        measurement: { kind: 'boolean' },
        checkpoints: null,
      },
      {
        targetMonth: '2026-08',
        activeLocalDate: '2026-08-15',
        timeZone: 'Asia/Yekaterinburg',
        kind: 'weekly_planned_task',
        periods: [],
      },
    )

    const componentKeys = (
      value: typeof scalar,
    ): readonly (readonly [string, string | null])[] =>
      value.fixedExpectations.map((row) => [row.componentKind, row.componentId])
    expect(componentKeys(scalar)).toEqual([
      ['goal', null],
      ['goal', null],
    ])
    expect(componentKeys(anyOf)).toEqual([
      ['goal', null],
      ['goal', null],
    ])
    expect(componentKeys(checklist)).toEqual([
      ['checklist_item', firstItemId],
      ['checklist_item', secondItemId],
      ['checklist_item', firstItemId],
      ['checklist_item', secondItemId],
    ])
    expect(componentKeys(checkpoints)).toEqual([
      ['checkpoint', checkpointOne],
      ['checkpoint', checkpointTwo],
      ['checkpoint', checkpointOne],
      ['checkpoint', checkpointTwo],
    ])
    expect(preactivationWeeklyTask.fixedExpectations).toEqual([])
    expect(preactivationWeeklyTask.flexiblePeriods).toEqual([])
  })

  it('rejects blockers and mismatched calculated targets before allocating any identity', () => {
    const build = builder()
    let allocations = 0
    const blocked = preview()
    ;(blocked as unknown as { blockers: unknown[] }).blockers = [
      {
        planGoalId: null,
        pointer: '/targetMonth',
        code: 'incompatible',
        detail: 'Target month is not current or next.',
      },
    ]
    expect(() =>
      build(blocked, {
        publicationId,
        publicationRevision: 1n,
        publishedByMemberId: publisherId,
        occurredAt: new Date('2026-08-14T19:00:00.000Z'),
        sourceRevisionIdByPlanGoalId: sourceRevisions,
        nextId: () => {
          allocations += 1
          return publicationId
        },
      }),
    ).toThrow()
    expect(allocations).toBe(0)

    const incomplete = preview()
    ;(
      incomplete as unknown as { calculatedTargets: unknown[] }
    ).calculatedTargets = []
    expect(() =>
      build(incomplete, {
        publicationId,
        publicationRevision: 1n,
        publishedByMemberId: publisherId,
        occurredAt: new Date('2026-08-14T19:00:00.000Z'),
        sourceRevisionIdByPlanGoalId: sourceRevisions,
        nextId: () => publicationId,
      }),
    ).toThrow()
  })

  it('rejects an incomplete goal config before allocating publication identities', () => {
    const input = preview()
    ;(
      input.goals[1] as unknown as {
        config: PublicationPreview['goals'][number]['config']
      }
    ).config = {
      schemaVersion: 1,
      scope: { kind: 'personal', ownerMemberId: publisherId },
      repetition: { kind: 'daily' },
      measurement: {
        kind: 'quantity',
        mode: 'targeted',
        unit: 'litres',
        precision: 0,
        aggregation: 'add',
        target: null,
      },
      checkpoints: null,
    }
    let allocations = 0

    expect(() =>
      builder()(input, {
        publicationId,
        publicationRevision: 1n,
        publishedByMemberId: publisherId,
        occurredAt: new Date('2026-08-14T19:00:00.000Z'),
        sourceRevisionIdByPlanGoalId: sourceRevisions,
        nextId: () => {
          allocations += 1
          return publicationId
        },
      }),
    ).toThrow('Publication preview goal config is not publishable')
    expect(allocations).toBe(0)
  })
})
