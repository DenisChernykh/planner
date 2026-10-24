import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import {
  APRIL_PLAN_SEED,
  resolveAprilPlanSeed,
  type AprilPlanSeedGoalV1,
} from '@/modules/planning/seed/april-plan.seed'
import {
  buildPublicationPreview,
  type PublicationCalculatedTarget,
} from '@/modules/planning/application/publication-preview'
import type {
  DraftEditorView,
  DraftGoalView,
} from '@/modules/planning/application/draft-goal.types'
import { validateGoalConfig } from '@/modules/planning/application/draft-goal-public.contract'

const denisMemberId = '11111111-1111-4111-8111-111111111111'
const tanyaMemberId = '22222222-2222-4222-8222-222222222222'
const planMonthId = '33333333-3333-4333-8333-333333333333'
const spaceId = '44444444-4444-4444-8444-444444444444'

const expectedGoalKeys = [
  'memberB_wake_time',
  'memberB_sleep_time',
  'goal_29',
  'goal_22',
  'memberB_water',
  'goal_36',
  'memberB_meal_schedule',
  'memberB_fresh_juice',
  'memberB_vitamin_d',
  'memberB_iron',
  'memberB_hair_care',
  'memberB_face_massage',
  'memberB_meditations',
  'goal_14',
  'memberB_fitness',
  'memberB_mfr',
  'memberB_steps',
  'goal_31',
  'shared_activity',
  'memberB_relax_evening',
  'memberB_new_skill',
  'goal_32',
  'goal_08',
  'goal_09',
  'goal_17',
  'goal_41',
  'memberB_promote_memberA',
  'memberA_fitness',
  'memberA_steps',
  'goal_04',
  'shared_order',
  'goal_01',
  'goal_06',
  'goal_24',
  'goal_25',
  'goal_26',
  'goal_27',
  'goal_28',
  'goal_10',
  'goal_37',
  'memberB_max_followers',
] as const

const expectedProvenance = [
  ['memberB_wake_time', 1, '/30'],
  ['memberB_sleep_time', 1, '/30'],
  ['goal_29', 1, '/30'],
  ['goal_22', 1, null],
  ['memberB_water', 1, '/30'],
  ['goal_36', 1, '/26'],
  ['memberB_meal_schedule', 2, '/30'],
  ['memberB_fresh_juice', 2, '/8'],
  ['memberB_vitamin_d', 2, '/30'],
  ['memberB_iron', 2, '/30'],
  ['memberB_hair_care', 2, '/8'],
  ['memberB_face_massage', 2, '/8'],
  ['memberB_meditations', 3, '/20'],
  ['goal_14', 3, '/30'],
  ['memberB_fitness', 3, '/8'],
  ['memberB_mfr', 3, '/8'],
  ['memberB_steps', 3, '/20'],
  ['goal_31', 3, '/8'],
  ['shared_activity', 4, '/10'],
  ['memberB_relax_evening', 4, '/8'],
  ['memberB_new_skill', 4, '/4'],
  ['goal_32', 4, '/8'],
  ['goal_08', 4, '/8'],
  ['goal_09', 5, null],
  ['goal_17', 5, '/12'],
  ['goal_41', 5, '/20'],
  ['memberB_promote_memberA', 5, '/8'],
  ['memberA_fitness', 5, '/8'],
  ['memberA_steps', 5, '/20'],
  ['goal_04', 5, '/30'],
  ['shared_order', 6, '/30'],
  ['goal_01', 6, '/30'],
  ['goal_06', 6, null],
  ['goal_24', 6, null],
  ['goal_25', 6, null],
  ['goal_26', 6, null],
  ['goal_27', 6, null],
  ['goal_28', 6, null],
  ['goal_10', 7, null],
  ['goal_37', 7, '/50'],
  ['memberB_max_followers', 7, null],
] as const

function identity(index: number): string {
  return `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function goal(key: (typeof expectedGoalKeys)[number]): AprilPlanSeedGoalV1 {
  const result = APRIL_PLAN_SEED.goals.find(
    (candidate) => candidate.seedGoalKey === key,
  )
  if (result === undefined) throw new Error(`missing seed goal ${key}`)
  return result
}

describe('P10 versioned April plan seed', () => {
  it('is the exact frozen v1 source inventory with one resolved goal per map row', () => {
    expect(APRIL_PLAN_SEED).toMatchObject({
      schemaVersion: 'planner.april-plan-seed.v1',
      seedId: 'april-plan',
      seedVersion: 1,
      sourceDocument: 'monthly-plan-template',
      renderedPageCount: 7,
      focus: 'Показатель 108',
    })
    expect(APRIL_PLAN_SEED.goals.map(({ seedGoalKey }) => seedGoalKey)).toEqual(
      expectedGoalKeys,
    )
    expect(new Set(expectedGoalKeys).size).toBe(41)
    expect(
      APRIL_PLAN_SEED.goals.map(({ seedGoalKey, sourceProvenance: source }) => [
        seedGoalKey,
        source.sourcePage,
        source.rawDenominator,
      ]),
    ).toEqual(expectedProvenance)
    expect(
      APRIL_PLAN_SEED.goals.every(
        ({ sourceProvenance }) =>
          sourceProvenance.rawValue !== null &&
          sourceProvenance.rawValue.trim().length > 0,
      ),
    ).toBe(true)
    expect(
      APRIL_PLAN_SEED.goals.reduce<Record<string, number>>((counts, item) => {
        counts[item.owner] = (counts[item.owner] ?? 0) + 1
        return counts
      }, {}),
    ).toEqual({ memberB: 34, shared: 3, memberA: 4 })
    expect(Object.isFrozen(APRIL_PLAN_SEED)).toBe(true)
    expect(Object.isFrozen(APRIL_PLAN_SEED.goals)).toBe(true)
    expect(
      APRIL_PLAN_SEED.goals.every(
        (item) =>
          Object.isFrozen(item) &&
          Object.isFrozen(item.config) &&
          Object.isFrozen(item.sourceProvenance),
      ),
    ).toBe(true)
    const componentIds = APRIL_PLAN_SEED.goals.flatMap(({ config }) => [
      ...(config.measurement.kind === 'checklist'
        ? config.measurement.items.map(({ itemId }) => itemId)
        : []),
      ...(config.measurement.kind === 'any_of'
        ? config.measurement.variants.map(({ variantId }) => variantId)
        : []),
      ...(config.checkpoints?.items.map(({ checkpointId }) => checkpointId) ??
        []),
    ])
    expect(componentIds).toHaveLength(27)
    expect(new Set(componentIds).size).toBe(27)
    expect(
      createHash('sha256')
        .update(JSON.stringify(APRIL_PLAN_SEED), 'utf8')
        .digest('hex'),
    ).toBe('b63f910965e2671e2ae174bddd8434a902efc1485ed44404c9520c6ba366ea8d')
  })

  it('preserves every approved ambiguous source decision in data', () => {
    expect(goal('memberB_meditations').config.repetition).toEqual({
      kind: 'monthly',
      n: '16',
    })
    expect(goal('memberB_fitness').config.repetition).toEqual({
      kind: 'weekly',
      n: '2',
    })
    expect(goal('shared_activity')).toMatchObject({
      owner: 'shared',
      config: { repetition: { kind: 'weekly', n: '2' } },
    })
    expect(goal('goal_32').config.measurement).toMatchObject({
      kind: 'checklist',
      items: [
        { label: 'вк' },
        { label: 'Дзен' },
        { label: 'тик-ток' },
        { label: 'инст' },
      ],
    })
    expect(goal('goal_08').config.measurement).toMatchObject({
      kind: 'checklist',
      items: [{ label: 'Telegram' }, { label: 'Дзен' }, { label: 'MAX' }],
    })
    expect(goal('goal_09').config.measurement).toEqual({
      kind: 'quantity',
      mode: 'targeted',
      unit: 'коллаборации',
      precision: 0,
      aggregation: 'add',
      target: '7',
    })
    expect(goal('goal_06')).toMatchObject({
      owner: 'shared',
      config: { measurement: { kind: 'text' } },
    })
    expect(
      APRIL_PLAN_SEED.goals
        .filter(
          ({ config }) => config.repetition.kind === 'weekly_planned_task',
        )
        .map(({ owner, config }) => ({ owner, repetition: config.repetition })),
    ).toEqual([
      {
        owner: 'memberB',
        repetition: {
          kind: 'weekly_planned_task',
          weekOrdinal: '1',
          taskText: 'Показатель 158',
        },
      },
      {
        owner: 'memberB',
        repetition: {
          kind: 'weekly_planned_task',
          weekOrdinal: '2',
          taskText: 'Показатель 157',
        },
      },
      {
        owner: 'memberB',
        repetition: {
          kind: 'weekly_planned_task',
          weekOrdinal: '3',
          taskText: 'Показатель 184',
        },
      },
      {
        owner: 'memberB',
        repetition: {
          kind: 'weekly_planned_task',
          weekOrdinal: '4',
          taskText: 'глемпенги',
        },
      },
      {
        owner: 'memberB',
        repetition: {
          kind: 'weekly_planned_task',
          weekOrdinal: '5',
          taskText: 'Показатель 195',
        },
      },
    ])
  })

  it('keeps the checked provenance JSON exact and complete', () => {
    const artifact = JSON.parse(
      readFileSync(
        'src/modules/planning/seed/april-plan.provenance.json',
        'utf8',
      ),
    ) as {
      readonly schemaVersion: string
      readonly seedSchemaVersion: string
      readonly sourceDocument: string
      readonly renderedPageCount: number
      readonly goals: readonly unknown[]
      readonly nonGoalEntries: readonly unknown[]
    }
    expect(artifact).toMatchObject({
      schemaVersion: 'planner.april-plan-provenance.v1',
      seedSchemaVersion: APRIL_PLAN_SEED.schemaVersion,
      sourceDocument: APRIL_PLAN_SEED.sourceDocument,
      renderedPageCount: 7,
    })
    expect(artifact.goals).toEqual(
      APRIL_PLAN_SEED.goals.map(({ seedGoalKey, sourceProvenance }) => ({
        seedGoalKey,
        ...sourceProvenance,
      })),
    )
    expect(artifact.nonGoalEntries).toEqual([
      {
        sourcePage: 1,
        rawValue: 'Показатель 009',
        disposition: 'visual_context_only',
        resolution: 'Показатель 074',
      },
      {
        sourcePage: 7,
        rawValue: 'ИТОГИ Апреля: УЧАСТНИК Б',
        disposition: 'provenance_summary',
        resolution: 'Показатель 104',
      },
      {
        sourcePage: 7,
        rawValue: 'Показатель 128',
        disposition: 'derived_report_only',
        resolution: 'Показатель 048',
      },
      {
        sourcePage: 7,
        rawValue: 'ИТОГИ Апреля: УЧАСТНИК А',
        disposition: 'provenance_summary',
        resolution: 'Показатель 105',
      },
    ])
  })

  it('binds symbolic owners into fresh publishable generic configs', () => {
    const resolved = resolveAprilPlanSeed({ denisMemberId, tanyaMemberId })
    expect(resolved.goals).toHaveLength(41)
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.goals)).toBe(true)
    expect(
      resolved.goals.every((item) => {
        const validation = validateGoalConfig(item.seedGoalKey, item.config)
        return validation.publishable && validation.blockers.length === 0
      }),
    ).toBe(true)
    expect(
      resolved.goals.find(
        ({ seedGoalKey }) => seedGoalKey === 'memberA_fitness',
      )?.config.scope,
    ).toEqual({ kind: 'personal', ownerMemberId: denisMemberId })
    expect(
      resolved.goals.find(({ seedGoalKey }) => seedGoalKey === 'goal_17')
        ?.config.scope,
    ).toEqual({ kind: 'personal', ownerMemberId: tanyaMemberId })
    expect(
      resolved.goals.find(({ seedGoalKey }) => seedGoalKey === 'shared_order')
        ?.config.scope,
    ).toEqual({ kind: 'shared' })
    expect(() =>
      resolveAprilPlanSeed({
        denisMemberId: 'not-a-member-id',
        tanyaMemberId,
      }),
    ).toThrow(TypeError)
    expect(() =>
      resolveAprilPlanSeed({
        denisMemberId,
        tanyaMemberId: denisMemberId,
      }),
    ).toThrow(TypeError)
  })

  it('passes the generic publication preview with calendar targets, not paper denominators', () => {
    const resolved = resolveAprilPlanSeed({ denisMemberId, tanyaMemberId })
    const planGoalIdByKey = new Map<string, string>()
    const goals: DraftGoalView[] = resolved.goals.map((item, index) => {
      const planGoalId = identity(index + 1)
      planGoalIdByKey.set(item.seedGoalKey, planGoalId)
      return {
        planGoalId,
        goalDefinitionId: identity(index + 101),
        goalDefinitionVersionId: identity(index + 201),
        goalSeriesId: identity(index + 301),
        title: item.title,
        why: item.why,
        category: item.category,
        displayOrder: index,
        configRevision: 1n,
        config: item.config,
        sourceProvenance: item.sourceProvenance,
        blockers: [],
      }
    })
    const editor: DraftEditorView = {
      planMonthId,
      spaceId,
      targetMonth: '2026-04',
      status: 'draft',
      focus: resolved.focus,
      planMonthRevision: 1n,
      draftRevision: 1n,
      goals,
      blockers: [],
    }
    const preview = buildPublicationPreview(editor, '2026-04-01')
    expect(preview.blockers).toEqual([])
    expect(preview.goals).toHaveLength(41)
    expect(preview.calculatedTargets).toHaveLength(41)

    const everyCalendarDate = preview.calculatedTargets.flatMap(
      ({ calendar }) =>
        calendar.kind === 'fixed'
          ? calendar.expectationDates
          : calendar.periods.flatMap((period) => [
              period.periodStart,
              period.periodEnd,
              ...('activeDates' in period ? period.activeDates : []),
              ...('eligibleDates' in period ? period.eligibleDates : []),
            ]),
    )
    expect(everyCalendarDate.length).toBeGreaterThan(0)
    expect(everyCalendarDate.every((date) => date.startsWith('2026-04-'))).toBe(
      true,
    )
    expect(everyCalendarDate).not.toContain('2026-03-30')
    expect(everyCalendarDate).not.toContain('2026-03-31')

    const target = (
      key: (typeof expectedGoalKeys)[number],
    ): PublicationCalculatedTarget['calendar'] => {
      const planGoalId = planGoalIdByKey.get(key)
      const result = preview.calculatedTargets.find(
        (candidate) => candidate.planGoalId === planGoalId,
      )
      if (result === undefined) throw new Error(`missing target for ${key}`)
      return result.calendar
    }
    const meditation = target('memberB_meditations')
    expect(meditation.kind).toBe('quota')
    if (meditation.kind !== 'quota') throw new Error('expected quota calendar')
    expect(meditation.periods.map(({ periodTarget }) => periodTarget)).toEqual([
      16,
    ])

    const shared = target('shared_activity')
    expect(shared.kind).toBe('quota')
    if (shared.kind !== 'quota') throw new Error('expected quota calendar')
    expect(
      shared.periods.reduce((sum, period) => sum + period.periodTarget, 0),
    ).toBe(8)
    expect(goal('shared_activity').sourceProvenance.rawDenominator).toBe('/10')

    const steps = target('memberB_steps')
    expect(steps.kind).toBe('quota')
    if (steps.kind !== 'quota') throw new Error('expected quota calendar')
    expect(
      steps.periods.reduce((sum, period) => sum + period.periodTarget, 0),
    ).toBe(22)
    expect(goal('memberB_steps').sourceProvenance.rawDenominator).toBe('/20')
  })
})
