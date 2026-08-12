import {
  DraftGoalConfigValidationError,
  draftGoalSeriesDecision,
  snapshotDraftGoalConfig,
  snapshotSourceProvenance,
  type DraftGoalConfigV1,
} from '@/modules/planning/domain/goal-config'
import { draftGoalPublishBlockers } from '@/modules/planning/domain/goal-validation'
import {
  validateGoalConfig,
  type GoalConfigV1,
  type PublishBlocker,
} from '@/modules/planning'

const ownerId = '11111111-1111-4111-8111-111111111111'
const goalA = '22222222-2222-4222-8222-222222222222'
const goalB = '33333333-3333-4333-8333-333333333333'
const itemA = '44444444-4444-4444-8444-444444444444'
const itemB = '55555555-5555-4555-8555-555555555555'
const generatedIds = [itemA, itemB]

function booleanGoal(): DraftGoalConfigV1 {
  return {
    schemaVersion: 1,
    scope: { kind: 'personal', ownerMemberId: ownerId },
    repetition: { kind: 'daily' },
    measurement: { kind: 'boolean' },
    checkpoints: null,
  }
}

function parse(
  value: unknown,
  previousConfig?: DraftGoalConfigV1,
): DraftGoalConfigV1 {
  let index = 0
  return snapshotDraftGoalConfig(value, {
    mode: previousConfig === undefined ? 'add' : 'update',
    ...(previousConfig === undefined ? {} : { previousConfig }),
    generateId: () => generatedIds[index++]!,
  })
}

function blockers(
  config: DraftGoalConfigV1,
  planGoalId = goalA,
  displayOrder = 0,
): readonly PublishBlocker[] {
  return draftGoalPublishBlockers([{ planGoalId, displayOrder, config }])
}

describe('P03 exact draft goal config', () => {
  it.each([
    {
      name: 'boolean daily',
      config: booleanGoal(),
    },
    {
      name: 'targeted quantity',
      config: {
        ...booleanGoal(),
        repetition: { kind: 'weekdays', weekdays: ['mon', 'wed', 'sun'] },
        measurement: {
          kind: 'quantity',
          mode: 'targeted',
          unit: 'мл',
          precision: 3,
          aggregation: 'add',
          target: '1200.500',
        },
      },
    },
    {
      name: 'informational quantity',
      config: {
        ...booleanGoal(),
        repetition: { kind: 'weekly', n: '9007199254740993' },
        measurement: {
          kind: 'quantity',
          mode: 'informational',
          unit: 'руб.',
          precision: 0,
          aggregation: 'latest',
          target: null,
        },
      },
    },
    {
      name: 'overnight actual time',
      config: {
        ...booleanGoal(),
        repetition: { kind: 'monthly', n: '2' },
        measurement: { kind: 'actual_time', start: '22:30', end: '07:00' },
      },
    },
    {
      name: 'rating',
      config: {
        ...booleanGoal(),
        repetition: { kind: 'one_off', dueDate: '2027-01-01' },
        measurement: { kind: 'rating', minimum: -10, maximum: 10 },
      },
    },
    {
      name: 'text',
      config: {
        ...booleanGoal(),
        scope: { kind: 'shared' },
        measurement: { kind: 'text' },
      },
    },
    {
      name: 'checklist',
      config: {
        ...booleanGoal(),
        measurement: {
          kind: 'checklist',
          items: [{ itemId: null, label: 'Первый пункт' }],
        },
      },
    },
    {
      name: 'or variants',
      config: {
        ...booleanGoal(),
        measurement: {
          kind: 'any_of',
          variants: [
            {
              variantId: null,
              label: 'Книга',
              unit: 'страницы',
              precision: 0,
              target: '100',
            },
          ],
        },
      },
    },
    {
      name: 'weekly planned boolean task',
      config: {
        ...booleanGoal(),
        repetition: {
          kind: 'weekly_planned_task',
          weekOrdinal: '5',
          taskText: 'Написать партнёрам',
        },
      },
    },
  ])('accepts and freezes a complete $name branch', ({ config }) => {
    const result = parse(config)
    expect(result).toEqual(
      config.measurement.kind === 'checklist'
        ? {
            ...config,
            measurement: {
              ...config.measurement,
              items: [{ itemId: itemA, label: 'Первый пункт' }],
            },
          }
        : 'variants' in config.measurement
          ? {
              ...config,
              measurement: {
                ...config.measurement,
                variants: [
                  {
                    ...config.measurement.variants[0]!,
                    variantId: itemA,
                  },
                ],
              },
            }
          : config,
    )
    expect(blockers(result)).toEqual([])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.scope)).toBe(true)
    expect(Object.isFrozen(result.measurement)).toBe(true)
  })

  it('stores incomplete leaves and returns every deterministic value-free blocker', () => {
    const config = parse({
      schemaVersion: 1,
      scope: { kind: 'personal', ownerMemberId: null },
      repetition: { kind: 'weekly', n: null },
      measurement: {
        kind: 'quantity',
        mode: 'targeted',
        unit: null,
        precision: null,
        aggregation: null,
        target: null,
      },
      checkpoints: null,
    })
    expect(blockers(config)).toEqual([
      {
        planGoalId: goalA,
        pointer: '/measurement/aggregation',
        code: 'required',
        detail: 'Required value is missing.',
      },
      {
        planGoalId: goalA,
        pointer: '/measurement/precision',
        code: 'required',
        detail: 'Required value is missing.',
      },
      {
        planGoalId: goalA,
        pointer: '/measurement/target',
        code: 'required',
        detail: 'Required value is missing.',
      },
      {
        planGoalId: goalA,
        pointer: '/measurement/unit',
        code: 'required',
        detail: 'Required value is missing.',
      },
      {
        planGoalId: goalA,
        pointer: '/repetition/n',
        code: 'required',
        detail: 'Required value is missing.',
      },
      {
        planGoalId: goalA,
        pointer: '/scope/ownerMemberId',
        code: 'required',
        detail: 'Required value is missing.',
      },
    ])
  })

  it('returns empty collection and compatibility blockers without fail-fast', () => {
    const config = parse({
      ...booleanGoal(),
      repetition: {
        kind: 'weekly_planned_task',
        weekOrdinal: null,
        taskText: null,
      },
      measurement: { kind: 'checklist', items: [] },
      checkpoints: {
        aggregation: null,
        items: [],
      },
    })
    expect(blockers(config)).toEqual([
      expect.objectContaining({
        pointer: '/checkpoints',
        code: 'incompatible',
      }),
      expect.objectContaining({
        pointer: '/checkpoints/aggregation',
        code: 'required',
      }),
      expect.objectContaining({
        pointer: '/checkpoints/items',
        code: 'empty_collection',
      }),
      expect.objectContaining({
        pointer: '/measurement',
        code: 'incompatible',
      }),
      expect.objectContaining({
        pointer: '/measurement/items',
        code: 'empty_collection',
      }),
      expect.objectContaining({
        pointer: '/repetition/taskText',
        code: 'required',
      }),
      expect.objectContaining({
        pointer: '/repetition/weekOrdinal',
        code: 'required',
      }),
    ])
  })

  it('is the only refined GoalConfigV1 constructor and returns a discriminated result', () => {
    expect(validateGoalConfig(goalA, booleanGoal())).toEqual({
      publishable: true,
      config: booleanGoal(),
      blockers: [],
    })
    expect(
      validateGoalConfig(goalA, {
        ...booleanGoal(),
        scope: { kind: 'personal', ownerMemberId: null },
      }),
    ).toEqual({
      publishable: false,
      config: null,
      blockers: [
        {
          planGoalId: goalA,
          pointer: '/scope/ownerMemberId',
          code: 'required',
          detail: 'Required value is missing.',
        },
      ],
    })
  })

  it('snapshots the public refinement boundary and rejects unchecked stored children without reading accessors', () => {
    const mutable = {
      ...booleanGoal(),
      measurement: {
        kind: 'checklist' as const,
        items: [{ itemId: itemA, label: 'Original' }],
      },
    }
    const result = validateGoalConfig(goalA, mutable)
    if (!result.publishable) throw new Error('fixture must be publishable')

    expect(result.config).not.toBe(mutable)
    expect(result.config.measurement).not.toBe(mutable.measurement)
    expect(Object.isFrozen(result.config)).toBe(true)
    expect(Object.isFrozen(result.config.measurement)).toBe(true)
    if (result.config.measurement.kind !== 'checklist') {
      throw new Error('fixture must be checklist')
    }
    expect(Object.isFrozen(result.config.measurement.items)).toBe(true)
    expect(Object.isFrozen(result.config.measurement.items[0])).toBe(true)
    mutable.measurement.items[0]!.label = 'Mutated after validation'
    expect(result.config.measurement.items[0].label).toBe('Original')

    expect(() =>
      validateGoalConfig(goalA, {
        ...mutable,
        measurement: {
          kind: 'checklist',
          items: [{ itemId: null, label: 'Missing stored ID' }],
        },
      }),
    ).toThrow(DraftGoalConfigValidationError)
    expect(() =>
      validateGoalConfig(goalA, {
        ...mutable,
        unexpected: true,
      } as unknown as DraftGoalConfigV1),
    ).toThrow(DraftGoalConfigValidationError)

    let reads = 0
    const accessor = Object.defineProperty({ ...mutable }, 'scope', {
      enumerable: true,
      get() {
        reads += 1
        return mutable.scope
      },
    }) as DraftGoalConfigV1
    expect(() => validateGoalConfig(goalA, accessor)).toThrow(
      DraftGoalConfigValidationError,
    )
    expect(reads).toBe(0)
  })

  it('exposes non-null branch fields to downstream P04/P05 types', () => {
    const assertQuantity = (config: GoalConfigV1): string => {
      if (config.measurement.kind !== 'quantity') return 'not-quantity'
      const unit: string = config.measurement.unit
      const precision: 0 | 1 | 2 | 3 = config.measurement.precision
      const aggregation: 'add' | 'latest' = config.measurement.aggregation
      const target: string | null = config.measurement.target
      return `${unit}:${precision}:${aggregation}:${target}`
    }
    const result = validateGoalConfig(
      goalA,
      parse({
        ...booleanGoal(),
        measurement: {
          kind: 'quantity',
          mode: 'targeted',
          unit: 'мл',
          precision: 0,
          aggregation: 'add',
          target: '1000',
        },
      }),
    )
    if (!result.publishable) throw new Error('fixture must be publishable')
    expect(assertQuantity(result.config)).toBe('мл:0:add:1000')
  })

  it('accepts daily checkpoints, assigns IDs and validates child satisfaction', () => {
    const config = parse({
      ...booleanGoal(),
      measurement: { kind: 'rating', minimum: 1, maximum: 10 },
      checkpoints: {
        aggregation: 'independent',
        items: [
          {
            checkpointId: null,
            name: 'Утро',
            deadline: '12:00',
            satisfaction: { kind: 'rating' },
          },
          {
            checkpointId: null,
            name: 'Вечер',
            deadline: '22:00',
            satisfaction: { kind: 'rating' },
          },
        ],
      },
    })
    expect(config.checkpoints?.items.map((item) => item.checkpointId)).toEqual([
      itemA,
      itemB,
    ])
    expect(blockers(config)).toEqual([])
  })

  it('applies the parent quantity precision to checkpoint targets', () => {
    const quantityWithCheckpoint = (precision: 0 | 1 | 2 | 3): object => ({
      ...booleanGoal(),
      measurement: {
        kind: 'quantity' as const,
        mode: 'targeted' as const,
        unit: 'л',
        precision,
        aggregation: 'add' as const,
        target: precision === 0 ? '2' : '2.000',
      },
      checkpoints: {
        aggregation: 'independent' as const,
        items: [
          {
            checkpointId: null,
            name: 'Утро',
            deadline: '12:00',
            satisfaction: { kind: 'quantity' as const, target: '1.500' },
          },
        ],
      },
    })

    expect(() => parse(quantityWithCheckpoint(0))).toThrow(
      DraftGoalConfigValidationError,
    )
    const precise = parse(quantityWithCheckpoint(3))
    expect(precise.checkpoints?.items[0]?.satisfaction).toEqual({
      kind: 'quantity',
      target: '1.500',
    })
    expect(blockers(precise)).toEqual([])
  })

  it.each([
    { mutation: { schemaVersion: 2 }, label: 'unknown schema version' },
    { mutation: { actorId: ownerId }, label: 'extra actor field' },
  ])('rejects $label structurally', ({ mutation }) => {
    expect(() => parse({ ...booleanGoal(), ...mutation })).toThrow(
      DraftGoalConfigValidationError,
    )
  })

  it('rejects accessors, symbols, boxed values and non-plain prototypes without invoking getters', () => {
    let reads = 0
    const accessor = Object.defineProperty({ ...booleanGoal() }, 'scope', {
      enumerable: true,
      get() {
        reads += 1
        return booleanGoal().scope
      },
    })
    const nestedAccessor = Object.defineProperty(
      { kind: 'personal' },
      'ownerMemberId',
      {
        enumerable: true,
        get() {
          reads += 1
          return ownerId
        },
      },
    )
    class ConfigClass {
      public readonly schemaVersion = 1
      public readonly scope = booleanGoal().scope
      public readonly repetition = booleanGoal().repetition
      public readonly measurement = booleanGoal().measurement
      public readonly checkpoints = null
    }
    for (const invalid of [
      accessor,
      { ...booleanGoal(), scope: nestedAccessor },
      Object.assign({ ...booleanGoal() }, { [Symbol('extra')]: true }),
      { ...booleanGoal(), scope: new String('personal') },
      Object.assign(Object.create(null), booleanGoal()),
      new ConfigClass(),
      [booleanGoal()],
    ]) {
      expect(() => parse(invalid)).toThrow(DraftGoalConfigValidationError)
    }
    expect(reads).toBe(0)
  })

  it('rejects sparse, subclassed and accessor arrays without reading elements', () => {
    let reads = 0
    const accessor: unknown[] = []
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get() {
        reads += 1
        return { itemId: null, label: 'A' }
      },
    })
    accessor.length = 1
    class Items extends Array<unknown> {}
    for (const items of [
      new Array(1),
      new Items({ itemId: null, label: 'A' }),
      accessor,
      Object.assign([{ itemId: null, label: 'A' }], { extra: true }),
    ]) {
      expect(() =>
        parse({
          ...booleanGoal(),
          measurement: { kind: 'checklist', items },
        }),
      ).toThrow(DraftGoalConfigValidationError)
    }
    expect(reads).toBe(0)
  })

  it.each([
    ['bad weekdays order', { kind: 'weekdays', weekdays: ['wed', 'mon'] }],
    ['duplicate weekdays', { kind: 'weekdays', weekdays: ['mon', 'mon'] }],
    ['signed N', { kind: 'weekly', n: '+2' }],
    ['range N', { kind: 'monthly', n: '2-3' }],
    ['invalid date', { kind: 'one_off', dueDate: '2026-02-30' }],
  ])('rejects structurally malformed %s', (_label, repetition) => {
    expect(() => parse({ ...booleanGoal(), repetition })).toThrow(
      DraftGoalConfigValidationError,
    )
  })

  it('accepts an early canonical Gregorian date without the Date.UTC 1900 offset', () => {
    expect(
      parse({
        ...booleanGoal(),
        repetition: { kind: 'one_off', dueDate: '0001-01-01' },
      }).repetition,
    ).toEqual({ kind: 'one_off', dueDate: '0001-01-01' })
  })

  it.each(['-1', '+1', '01', '1e3', '1.2345', ' 1'])(
    'rejects noncanonical quantity %s for precision 3',
    (target) => {
      expect(() =>
        parse({
          ...booleanGoal(),
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            unit: 'л',
            precision: 3,
            aggregation: 'add',
            target,
          },
        }),
      ).toThrow(DraftGoalConfigValidationError)
    },
  )

  it('bounds every child collection and one config shape', () => {
    const items = Array.from({ length: 101 }, (_, index) => ({
      itemId: null,
      label: `item-${index}`,
    }))
    expect(() =>
      parse({
        ...booleanGoal(),
        measurement: { kind: 'checklist', items },
      }),
    ).toThrow(DraftGoalConfigValidationError)
  })

  it('preserves known update child IDs, assigns only new IDs and rejects forged reuse', () => {
    const before = parse({
      ...booleanGoal(),
      measurement: {
        kind: 'checklist',
        items: [{ itemId: null, label: 'A' }],
      },
    })
    const updated = parse(
      {
        ...before,
        measurement: {
          kind: 'checklist',
          items: [
            { itemId: itemA, label: 'A renamed' },
            { itemId: null, label: 'B' },
          ],
        },
      },
      before,
    )
    expect(updated.measurement).toEqual({
      kind: 'checklist',
      items: [
        { itemId: itemA, label: 'A renamed' },
        { itemId: itemB, label: 'B' },
      ],
    })
    expect(() =>
      parse(
        {
          ...before,
          measurement: {
            kind: 'checklist',
            items: [{ itemId: itemB, label: 'forged' }],
          },
        },
        before,
      ),
    ).toThrow(DraftGoalConfigValidationError)
  })

  it('snapshots exact bounded provenance and excludes no fields', () => {
    const value = {
      schemaVersion: 1,
      sourceDocument: ' monthly-plan-template ',
      sourcePage: 6,
      rawValue: '2–3',
      rawDenominator: null,
      resolution: 'Выбрано N=2',
    }
    const result = snapshotSourceProvenance(value)
    expect(result).toEqual(value)
    expect(Object.isFrozen(result)).toBe(true)
    for (const invalid of [
      { ...value, sourcePage: 0 },
      { ...value, sourceDocument: ' ' },
      { ...value, resolution: 'x'.repeat(501) },
      { ...value, rawValue: 'x'.repeat(2_001) },
      { ...value, userId: ownerId },
    ]) {
      expect(() => snapshotSourceProvenance(invalid)).toThrow(
        DraftGoalConfigValidationError,
      )
    }
  })

  it('sorts blockers by display order, goal ID, pointer and code', () => {
    const incomplete = parse({
      ...booleanGoal(),
      scope: { kind: 'personal', ownerMemberId: null },
    })
    expect(
      draftGoalPublishBlockers([
        { planGoalId: goalB, displayOrder: 2, config: incomplete },
        { planGoalId: goalA, displayOrder: 1, config: incomplete },
      ]).map((issue) => issue.planGoalId),
    ).toEqual([goalA, goalB])
  })
})

describe('P03 analytical series decision', () => {
  const cases: readonly [
    string,
    (config: DraftGoalConfigV1) => DraftGoalConfigV1,
    'continue' | 'new',
  ][] = [
    [
      'repetition',
      (config) => ({ ...config, repetition: { kind: 'weekly', n: '3' } }),
      'continue',
    ],
    [
      'target',
      (config) => ({
        ...config,
        measurement: {
          kind: 'quantity',
          mode: 'targeted',
          unit: 'мл',
          precision: 0,
          aggregation: 'add',
          target: '2000',
        },
      }),
      'continue',
    ],
    ['scope', (config) => ({ ...config, scope: { kind: 'shared' } }), 'new'],
    [
      'measurement kind',
      (config) => ({ ...config, measurement: { kind: 'text' } }),
      'new',
    ],
    [
      'quantity unit',
      (config) => ({
        ...config,
        measurement: {
          kind: 'quantity',
          mode: 'targeted',
          unit: 'л',
          precision: 0,
          aggregation: 'add',
          target: '1000',
        },
      }),
      'new',
    ],
    [
      'quantity precision',
      (config) => ({
        ...config,
        measurement: {
          kind: 'quantity',
          mode: 'targeted',
          unit: 'мл',
          precision: 1,
          aggregation: 'add',
          target: '1000.0',
        },
      }),
      'new',
    ],
    [
      'quantity aggregation',
      (config) => ({
        ...config,
        measurement: {
          kind: 'quantity',
          mode: 'targeted',
          unit: 'мл',
          precision: 0,
          aggregation: 'latest',
          target: '1000',
        },
      }),
      'new',
    ],
  ]

  it.each(cases)('%s => %s', (_name, mutate, expected) => {
    const base = parse({
      ...booleanGoal(),
      measurement: {
        kind: 'quantity',
        mode: 'targeted',
        unit: 'мл',
        precision: 0,
        aggregation: 'add',
        target: '1000',
      },
    })
    expect(draftGoalSeriesDecision(base, mutate(base))).toBe(expected)
  })

  it('uses stable component identity/schema but ignores labels, targets and provenance', () => {
    const before = parse({
      ...booleanGoal(),
      measurement: {
        kind: 'any_of',
        variants: [
          {
            variantId: null,
            label: 'Книга',
            unit: 'страницы',
            precision: 0,
            target: '100',
          },
        ],
      },
    })
    const compatible = parse(
      {
        ...before,
        measurement: {
          kind: 'any_of',
          variants: [
            {
              variantId: itemA,
              label: 'Книга renamed',
              unit: 'страницы',
              precision: 0,
              target: '200',
            },
          ],
        },
      },
      before,
    )
    expect(draftGoalSeriesDecision(before, compatible)).toBe('continue')
    if (compatible.measurement.kind !== 'any_of') {
      throw new Error('fixture must be any_of')
    }
    expect(
      draftGoalSeriesDecision(before, {
        ...compatible,
        measurement: {
          kind: 'any_of',
          variants: [
            ...compatible.measurement.variants,
            {
              variantId: itemB,
              label: 'Аудио',
              unit: 'минуты',
              precision: 0,
              target: '60',
            },
          ],
        },
      }),
    ).toBe('new')
  })
})
