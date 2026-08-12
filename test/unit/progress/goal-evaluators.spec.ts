import {
  CALENDAR_TARGETS_FORMULA_VERSION,
  GOAL_EVALUATION_FORMULA_VERSION,
  GoalEvaluationInputError,
  calculateEligibleCalendar,
  evaluateGoalProgress,
  type CalendarTargetsInput,
  type EvaluateGoalProgressInput,
  type GoalEvaluationFactV1,
  type GoalEvaluationSnapshotV1,
  type SuccessfulEligibleCalendarResult,
} from '@/modules/progress'
import type { DraftGoalConfigV1, GoalConfigV1 } from '@/modules/planning'

const timeZone = 'Asia/Yekaterinburg' as const
const snapshotVersion = 'planner.goal-evaluation-snapshot.v1' as const

type IsAssignable<Left, Right> = Left extends Right ? true : false

describe('P05 planning-to-progress compile-time seam', () => {
  it('requires an explicit projection from both refined and draft configs', () => {
    const refinedIsNotSnapshot: IsAssignable<
      GoalConfigV1,
      GoalEvaluationSnapshotV1
    > = false
    const draftIsNotSnapshot: IsAssignable<
      DraftGoalConfigV1,
      GoalEvaluationSnapshotV1
    > = false

    expect(refinedIsNotSnapshot).toBe(false)
    expect(draftIsNotSnapshot).toBe(false)
  })
})

interface CalendarFixture {
  readonly calendarInput: CalendarTargetsInput
  readonly calendar: SuccessfulEligibleCalendarResult
  readonly defaultAsOfLocalDate: string
}

function calendarFixture(
  calendarInput: CalendarTargetsInput,
  defaultAsOfLocalDate: string,
): CalendarFixture {
  const calendar = calculateEligibleCalendar(calendarInput)
  if (!calendar.eligible) throw new Error('expected an eligible P04 fixture')
  return { calendarInput, calendar, defaultAsOfLocalDate }
}

function fixedCalendar(expectationDates: readonly string[]): CalendarFixture {
  if (expectationDates.length === 0) {
    throw new Error('fixed test fixture requires an expectation')
  }
  const first = expectationDates[0]!
  const last = expectationDates[expectationDates.length - 1]!
  return calendarFixture(
    {
      targetMonth: first.slice(0, 7),
      activeLocalDate: first,
      timeZone,
      repetition:
        expectationDates.length === 1
          ? { kind: 'one_off', dueDate: first }
          : { kind: 'daily' },
    },
    last,
  )
}

function quotaCalendar(
  repetition: { readonly kind: 'weekly' | 'monthly'; readonly n: string },
  options: {
    readonly targetMonth?: string
    readonly activeLocalDate?: string
    readonly asOfLocalDate?: string
  } = {},
): CalendarFixture {
  const targetMonth = options.targetMonth ?? '2026-04'
  return calendarFixture(
    {
      targetMonth,
      activeLocalDate: options.activeLocalDate ?? `${targetMonth}-01`,
      timeZone,
      repetition,
    },
    options.asOfLocalDate ?? `${targetMonth}-30`,
  )
}

function weeklyTaskCalendar(
  weekOrdinal: '1' | '2' | '3' | '4' | '5',
): CalendarFixture {
  return calendarFixture(
    {
      targetMonth: '2026-04',
      activeLocalDate: '2026-04-01',
      timeZone,
      repetition: { kind: 'weekly_planned_task', weekOrdinal },
    },
    '2026-04-30',
  )
}

function mutateCalendar(
  fixture: CalendarFixture,
  calendar: unknown,
): CalendarFixture {
  return {
    ...fixture,
    calendar: {
      ...fixture.calendar,
      calendar,
    } as unknown as SuccessfulEligibleCalendarResult,
  }
}

function dates(from: number, to: number): readonly string[] {
  return Array.from(
    { length: to - from + 1 },
    (_, index) => `2026-04-${String(from + index).padStart(2, '0')}`,
  )
}

function booleanSnapshot(): GoalEvaluationSnapshotV1 {
  return {
    schemaVersion: snapshotVersion,
    measurement: { kind: 'boolean' },
    checkpoints: null,
  }
}

function input(
  snapshot: GoalEvaluationSnapshotV1,
  calendarFixtureValue: CalendarFixture,
  facts: readonly GoalEvaluationFactV1[],
  asOfLocalDate = calendarFixtureValue.defaultAsOfLocalDate,
): EvaluateGoalProgressInput {
  return {
    snapshot,
    calendarInput: calendarFixtureValue.calendarInput,
    calendar: calendarFixtureValue.calendar,
    facts,
    asOfLocalDate,
  }
}

function available(
  numerator: string,
  denominator: string,
  basisPoints: string,
): {
  readonly available: true
  readonly exact: { readonly numerator: string; readonly denominator: string }
  readonly basisPoints: string
} {
  return {
    available: true,
    exact: { numerator, denominator },
    basisPoints,
  }
}

function unavailable(reason: 'informational' | 'no_applicable_units'): {
  readonly available: false
  readonly exact: null
  readonly basisPoints: null
  readonly reason: typeof reason
} {
  return { available: false, exact: null, basisPoints: null, reason }
}

function expectInputIssue(
  action: () => unknown,
  pointer: string,
  code: string,
): void {
  try {
    action()
    throw new Error('expected GoalEvaluationInputError')
  } catch (error) {
    expect(error).toBeInstanceOf(GoalEvaluationInputError)
    expect((error as GoalEvaluationInputError).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ pointer, code })]),
    )
  }
}

function observedArray<T>(target: T[]): {
  readonly value: readonly T[]
  readonly boundaryReads: () => number
} {
  let boundaryReads = 0
  const value = new Proxy(target, {
    ownKeys(current) {
      boundaryReads += 1
      return Reflect.ownKeys(current)
    },
    getOwnPropertyDescriptor(current, property) {
      boundaryReads += 1
      return Reflect.getOwnPropertyDescriptor(current, property)
    },
  })
  return { value, boundaryReads: () => boundaryReads }
}

function overLimitArray<T>(): ReturnType<typeof observedArray<T>> {
  const target: T[] = []
  target.length = 10_001
  return observedArray(target)
}

describe('P05 fixed goal evaluation', () => {
  it('distinguishes done, not-done and absent boolean facts', () => {
    const result = evaluateGoalProgress(
      input(booleanSnapshot(), fixedCalendar(dates(1, 3)), [
        {
          kind: 'fixed',
          expectationDate: '2026-04-01',
          value: { kind: 'boolean', result: 'done' },
        },
        {
          kind: 'fixed',
          expectationDate: '2026-04-02',
          value: { kind: 'boolean', result: 'not_done' },
        },
      ]),
    )

    expect(result).toEqual({
      formulaVersions: {
        calendar: CALENDAR_TARGETS_FORMULA_VERSION,
        evaluation: GOAL_EVALUATION_FORMULA_VERSION,
      },
      progress: available('1', '3', '3333'),
      score: available('1', '3', '3333'),
      overperformance: available('0', '1', '0'),
      coverage: { filled: '2', applicable: '3' },
      contribution: {
        score: { numerator: '1', denominator: '3' },
        coverage: { filled: '2', applicable: '3' },
      },
      periods: [],
    })
  })

  it('uses inclusive as-of and excludes future expectations instead of creating no-data', () => {
    const result = evaluateGoalProgress(
      input(
        booleanSnapshot(),
        fixedCalendar(dates(1, 3)),
        [
          {
            kind: 'fixed',
            expectationDate: '2026-04-02',
            value: { kind: 'boolean', result: 'done' },
          },
        ],
        '2026-04-02',
      ),
    )
    expect(result.progress).toEqual(available('1', '2', '5000'))
    expect(result.coverage).toEqual({ filled: '1', applicable: '2' })

    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            booleanSnapshot(),
            fixedCalendar(dates(1, 3)),
            [
              {
                kind: 'fixed',
                expectationDate: '2026-04-03',
                value: { kind: 'boolean', result: 'done' },
              },
            ],
            '2026-04-02',
          ),
        ),
      '/facts/0/expectationDate',
      'incompatible',
    )
  })

  it('keeps add contributions exact, including decimal 0.1 + 0.2', () => {
    const addSnapshot: GoalEvaluationSnapshotV1 = {
      schemaVersion: snapshotVersion,
      measurement: {
        kind: 'quantity',
        mode: 'targeted',
        precision: 0,
        aggregation: 'add',
        target: '1000',
      },
      checkpoints: null,
    }
    const result = evaluateGoalProgress(
      input(addSnapshot, fixedCalendar(['2026-04-01']), [
        {
          kind: 'fixed',
          expectationDate: '2026-04-01',
          value: {
            kind: 'quantity_add',
            contributions: [
              { contributionId: 'water-1', value: '400' },
              { contributionId: 'water-2', value: '800' },
            ],
          },
        },
      ]),
    )
    expect(result.progress).toEqual(available('6', '5', '12000'))
    expect(result.score).toEqual(available('1', '1', '10000'))
    expect(result.overperformance).toEqual(available('1', '5', '2000'))

    const decimalResult = evaluateGoalProgress(
      input(
        {
          ...addSnapshot,
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            precision: 1,
            aggregation: 'add',
            target: '0.3',
          },
        },
        fixedCalendar(['2026-04-01']),
        [
          {
            kind: 'fixed',
            expectationDate: '2026-04-01',
            value: {
              kind: 'quantity_add',
              contributions: [
                { contributionId: 'decimal-1', value: '0.1' },
                { contributionId: 'decimal-2', value: '0.2' },
              ],
            },
          },
        ],
      ),
    )
    expect(decimalResult.progress).toEqual(available('1', '1', '10000'))
  })

  it('uses only the one current latest value', () => {
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            precision: 0,
            aggregation: 'latest',
            target: '10000',
          },
          checkpoints: null,
        },
        fixedCalendar(['2026-04-01']),
        [
          {
            kind: 'fixed',
            expectationDate: '2026-04-01',
            value: { kind: 'quantity_latest', value: '7000' },
          },
        ],
      ),
    )
    expect(result.progress).toEqual(available('7', '10', '7000'))
  })

  it('keeps 130 percent raw progress and caps only score', () => {
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            precision: 0,
            aggregation: 'latest',
            target: '100',
          },
          checkpoints: null,
        },
        fixedCalendar(['2026-04-01']),
        [
          {
            kind: 'fixed',
            expectationDate: '2026-04-01',
            value: { kind: 'quantity_latest', value: '130' },
          },
        ],
      ),
    )
    expect(result.progress).toEqual(available('13', '10', '13000'))
    expect(result.score).toEqual(available('1', '1', '10000'))
    expect(result.overperformance).toEqual(available('3', '10', '3000'))
  })

  it('separates fixed and quota informational quantity coverage', () => {
    const snapshot: GoalEvaluationSnapshotV1 = {
      schemaVersion: snapshotVersion,
      measurement: {
        kind: 'quantity',
        mode: 'informational',
        precision: 0,
        aggregation: 'latest',
        target: null,
      },
      checkpoints: null,
    }
    const fact = { kind: 'quantity_latest', value: '7' } as const
    const fixed = evaluateGoalProgress(
      input(snapshot, fixedCalendar(['2026-04-01']), [
        { kind: 'fixed', expectationDate: '2026-04-01', value: fact },
      ]),
    )
    expect(fixed.progress).toEqual(unavailable('informational'))
    expect(fixed.score).toEqual(unavailable('informational'))
    expect(fixed.overperformance).toEqual(unavailable('informational'))
    expect(fixed.coverage).toEqual({ filled: '1', applicable: '1' })
    expect(fixed.contribution.score).toBeNull()

    const quota = evaluateGoalProgress(
      input(snapshot, quotaCalendar({ kind: 'monthly', n: '3' }), [
        { kind: 'quota_occurrence', localDate: '2026-04-01', value: fact },
      ]),
    )
    expect(quota.progress).toEqual(unavailable('informational'))
    expect(quota.coverage).toEqual({ filled: '0', applicable: '0' })
  })

  it('keeps informational checkpoint completeness in the normal independent coverage shape', () => {
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: {
            kind: 'quantity',
            mode: 'informational',
            precision: 0,
            aggregation: 'latest',
            target: null,
          },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: 'morning',
                satisfaction: { kind: 'quantity', target: '1' },
              },
              {
                checkpointId: 'evening',
                satisfaction: { kind: 'quantity', target: '1' },
              },
            ],
          },
        },
        fixedCalendar(['2026-04-01']),
        [
          {
            kind: 'fixed_checkpoints',
            expectationDate: '2026-04-01',
            checkpoints: [
              {
                checkpointId: 'morning',
                value: { kind: 'quantity_latest', value: '7' },
              },
            ],
          },
        ],
      ),
    )

    expect(result.progress).toEqual(unavailable('informational'))
    expect(result.score).toEqual(unavailable('informational'))
    expect(result.coverage).toEqual({ filled: '1', applicable: '2' })
  })

  it('treats normal and overnight time boundaries as inclusive', () => {
    const run = (
      start: string,
      end: string,
      values: readonly string[],
    ): ReturnType<typeof evaluateGoalProgress> =>
      evaluateGoalProgress(
        input(
          {
            schemaVersion: snapshotVersion,
            measurement: { kind: 'actual_time', start, end },
            checkpoints: null,
          },
          fixedCalendar(dates(1, values.length)),
          values.map((value, index) => ({
            kind: 'fixed' as const,
            expectationDate: `2026-04-${String(index + 1).padStart(2, '0')}`,
            value: { kind: 'actual_time' as const, value },
          })),
        ),
      )

    expect(run('09:00', '10:00', ['09:00', '10:00', '10:01']).progress).toEqual(
      available('2', '3', '6667'),
    )
    expect(run('22:30', '07:00', ['22:30', '07:00', '12:00']).progress).toEqual(
      available('2', '3', '6667'),
    )
  })

  it('counts every valid rating including minimum and maximum as satisfied', () => {
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: { kind: 'rating', minimum: 1, maximum: 10 },
          checkpoints: null,
        },
        fixedCalendar(dates(1, 2)),
        [
          {
            kind: 'fixed',
            expectationDate: '2026-04-01',
            value: { kind: 'rating', value: 1 },
          },
          {
            kind: 'fixed',
            expectationDate: '2026-04-02',
            value: { kind: 'rating', value: 10 },
          },
        ],
      ),
    )
    expect(result.progress).toEqual(available('1', '1', '10000'))
    expect(result.coverage).toEqual({ filled: '2', applicable: '2' })
  })

  it('requires nonempty text but only done text increases progress', () => {
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: { kind: 'text' },
          checkpoints: null,
        },
        fixedCalendar(dates(1, 3)),
        [
          {
            kind: 'fixed',
            expectationDate: '2026-04-01',
            value: { kind: 'text', text: 'Write proposal', result: 'done' },
          },
          {
            kind: 'fixed',
            expectationDate: '2026-04-02',
            value: {
              kind: 'text',
              text: 'Could not finish',
              result: 'not_done',
            },
          },
        ],
      ),
    )
    expect(result.progress).toEqual(available('1', '3', '3333'))
    expect(result.coverage).toEqual({ filled: '2', applicable: '3' })
  })

  it('uses checklist items as units without an extra parent', () => {
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: {
            kind: 'checklist',
            items: [
              { itemId: 'a' },
              { itemId: 'b' },
              { itemId: 'c' },
              { itemId: 'd' },
            ],
          },
          checkpoints: null,
        },
        fixedCalendar(['2026-04-01']),
        [
          {
            kind: 'fixed',
            expectationDate: '2026-04-01',
            value: {
              kind: 'checklist',
              items: [
                { itemId: 'a', state: 'done' },
                { itemId: 'b', state: 'done' },
                { itemId: 'c', state: 'not_done' },
              ],
            },
          },
        ],
      ),
    )
    expect(result.progress).toEqual(available('1', '2', '5000'))
    expect(result.score).toEqual(available('1', '2', '5000'))
    expect(result.coverage).toEqual({ filled: '3', applicable: '4' })
  })

  it('treats explicit checklist not-done as all item units filled with zero achievement', () => {
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: {
            kind: 'checklist',
            items: [
              { itemId: 'one' },
              { itemId: 'two' },
              { itemId: 'three' },
              { itemId: 'four' },
            ],
          },
          checkpoints: null,
        },
        fixedCalendar(['2026-04-01']),
        [
          {
            kind: 'fixed',
            expectationDate: '2026-04-01',
            value: { kind: 'not_done' },
          },
        ],
      ),
    )

    expect(result.progress).toEqual(available('0', '1', '0'))
    expect(result.coverage).toEqual({ filled: '4', applicable: '4' })
  })

  it('uses maximum any-of variant ratio instead of summing variants', () => {
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: {
            kind: 'any_of',
            variants: [
              { variantId: 'pages', precision: 0, target: '100' },
              { variantId: 'audio', precision: 0, target: '60' },
            ],
          },
          checkpoints: null,
        },
        fixedCalendar(['2026-04-01']),
        [
          {
            kind: 'fixed',
            expectationDate: '2026-04-01',
            value: {
              kind: 'any_of',
              variants: [
                { variantId: 'pages', value: '50' },
                { variantId: 'audio', value: '30' },
              ],
            },
          },
        ],
      ),
    )
    expect(result.progress).toEqual(available('1', '2', '5000'))
    expect(result.coverage).toEqual({ filled: '1', applicable: '1' })
  })
})

describe('P05 checkpoint evaluation', () => {
  it('keeps exact child ratios until the independent parent mean', () => {
    const calendarDates = dates(1, 6)
    const facts: GoalEvaluationFactV1[] = calendarDates
      .slice(0, 3)
      .map((date, index) => ({
        kind: 'fixed_checkpoints',
        expectationDate: date,
        checkpoints: [
          {
            checkpointId: 'morning',
            value: { kind: 'boolean' as const, result: 'done' as const },
          },
          ...(index === 0
            ? [
                {
                  checkpointId: 'evening',
                  value: { kind: 'boolean' as const, result: 'done' as const },
                },
              ]
            : []),
        ],
      }))
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: { kind: 'boolean' },
          checkpoints: {
            aggregation: 'independent',
            items: [
              { checkpointId: 'morning', satisfaction: { kind: 'boolean' } },
              { checkpointId: 'evening', satisfaction: { kind: 'boolean' } },
            ],
          },
        },
        fixedCalendar(calendarDates),
        facts,
      ),
    )
    expect(result.progress).toEqual(available('1', '3', '3333'))
    expect(result.score).toEqual(available('1', '3', '3333'))
    expect(result.coverage).toEqual({ filled: '4', applicable: '12' })
  })

  it('caps each independent child before the score mean', () => {
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            precision: 0,
            aggregation: 'latest',
            target: '100',
          },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: 'first',
                satisfaction: { kind: 'quantity', target: '100' },
              },
              {
                checkpointId: 'second',
                satisfaction: { kind: 'quantity', target: '100' },
              },
            ],
          },
        },
        fixedCalendar(['2026-04-01']),
        [
          {
            kind: 'fixed_checkpoints',
            expectationDate: '2026-04-01',
            checkpoints: [
              {
                checkpointId: 'first',
                value: { kind: 'quantity_latest', value: '130' },
              },
              {
                checkpointId: 'second',
                value: { kind: 'quantity_latest', value: '50' },
              },
            ],
          },
        ],
      ),
    )
    expect(result.progress).toEqual(available('9', '10', '9000'))
    expect(result.score).toEqual(available('3', '4', '7500'))
    expect(result.overperformance).toEqual(available('3', '20', '1500'))
    expect(result.coverage).toEqual({ filled: '2', applicable: '2' })
  })

  it('makes all one parent-date unit for both achievement and coverage', () => {
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: { kind: 'boolean' },
          checkpoints: {
            aggregation: 'all',
            items: [
              { checkpointId: 'a', satisfaction: { kind: 'boolean' } },
              { checkpointId: 'b', satisfaction: { kind: 'boolean' } },
            ],
          },
        },
        fixedCalendar(dates(1, 3)),
        [
          {
            kind: 'fixed_checkpoints',
            expectationDate: '2026-04-01',
            checkpoints: [
              { checkpointId: 'a', value: { kind: 'boolean', result: 'done' } },
              { checkpointId: 'b', value: { kind: 'boolean', result: 'done' } },
            ],
          },
          {
            kind: 'fixed_checkpoints',
            expectationDate: '2026-04-02',
            checkpoints: [
              {
                checkpointId: 'a',
                value: { kind: 'boolean', result: 'not_done' },
              },
              {
                checkpointId: 'b',
                value: { kind: 'boolean', result: 'not_done' },
              },
            ],
          },
          {
            kind: 'fixed_checkpoints',
            expectationDate: '2026-04-03',
            checkpoints: [
              { checkpointId: 'a', value: { kind: 'boolean', result: 'done' } },
            ],
          },
        ],
      ),
    )
    expect(result.progress).toEqual(available('1', '3', '3333'))
    expect(result.coverage).toEqual({ filled: '2', applicable: '3' })
  })
})

describe('P05 flexible and weekly task evaluation', () => {
  it('turns two half occurrences into one equivalent occurrence', () => {
    const snapshot: GoalEvaluationSnapshotV1 = {
      schemaVersion: snapshotVersion,
      measurement: {
        kind: 'quantity',
        mode: 'targeted',
        precision: 0,
        aggregation: 'latest',
        target: '100',
      },
      checkpoints: null,
    }
    const result = evaluateGoalProgress(
      input(
        snapshot,
        quotaCalendar({ kind: 'monthly', n: '2' }),
        [
          {
            kind: 'quota_occurrence',
            localDate: '2026-04-01',
            value: { kind: 'quantity_latest', value: '50' },
          },
          {
            kind: 'quota_occurrence',
            localDate: '2026-04-02',
            value: { kind: 'quantity_latest', value: '50' },
          },
        ],
        '2026-04-30',
      ),
    )
    expect(result.progress).toEqual(available('1', '2', '5000'))
    expect(result.score).toEqual(available('1', '2', '5000'))
    expect(result.overperformance).toEqual(available('0', '1', '0'))
    expect(result.coverage).toEqual({ filled: '0', applicable: '0' })
    expect(result.periods).toEqual([
      {
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        periodTarget: '2',
        actualEquivalentOccurrences: { numerator: '1', denominator: '1' },
        creditedOccurrences: { numerator: '1', denominator: '1' },
        overperformanceOccurrences: { numerator: '0', denominator: '1' },
      },
    ])
  })

  it('caps each period independently and transfers no surplus debt', () => {
    const result = evaluateGoalProgress(
      input(
        booleanSnapshot(),
        quotaCalendar(
          { kind: 'weekly', n: '2' },
          {
            targetMonth: '2026-06',
            activeLocalDate: '2026-06-01',
            asOfLocalDate: '2026-06-14',
          },
        ),
        [
          {
            kind: 'quota_occurrence',
            localDate: '2026-06-01',
            value: { kind: 'boolean', result: 'done' },
          },
          {
            kind: 'quota_occurrence',
            localDate: '2026-06-02',
            value: { kind: 'boolean', result: 'done' },
          },
          {
            kind: 'quota_occurrence',
            localDate: '2026-06-03',
            value: { kind: 'boolean', result: 'done' },
          },
        ],
        '2026-06-14',
      ),
    )
    expect(result.progress).toEqual(available('3', '4', '7500'))
    expect(result.score).toEqual(available('1', '2', '5000'))
    expect(result.overperformance).toEqual(available('1', '4', '2500'))
    expect(result.periods.map((period) => period.creditedOccurrences)).toEqual([
      { numerator: '2', denominator: '1' },
      { numerator: '0', denominator: '1' },
    ])
  })

  it('excludes target-zero periods and reports zero total target as unavailable', () => {
    const result = evaluateGoalProgress(
      input(
        booleanSnapshot(),
        quotaCalendar(
          { kind: 'weekly', n: '2' },
          {
            targetMonth: '2026-06',
            activeLocalDate: '2026-06-08',
            asOfLocalDate: '2026-06-07',
          },
        ),
        [],
        '2026-06-07',
      ),
    )
    expect(result.progress).toEqual(unavailable('no_applicable_units'))
    expect(result.score).toEqual(unavailable('no_applicable_units'))
    expect(result.overperformance).toEqual(unavailable('no_applicable_units'))
    expect(result.periods).toEqual([])
  })

  it('enters one scored weekly task at period start but excludes it from coverage', () => {
    const calendar = weeklyTaskCalendar('2')
    const before = evaluateGoalProgress(
      input(booleanSnapshot(), calendar, [], '2026-04-05'),
    )
    expect(before.progress).toEqual(unavailable('no_applicable_units'))

    const missing = evaluateGoalProgress(
      input(booleanSnapshot(), calendar, [], '2026-04-06'),
    )
    expect(missing.progress).toEqual(available('0', '1', '0'))
    expect(missing.score).toEqual(available('0', '1', '0'))
    expect(missing.coverage).toEqual({ filled: '0', applicable: '0' })

    const done = evaluateGoalProgress(
      input(
        booleanSnapshot(),
        calendar,
        [
          {
            kind: 'weekly_planned_task',
            periodStart: '2026-04-06',
            periodEnd: '2026-04-12',
            result: 'done',
          },
        ],
        '2026-04-06',
      ),
    )
    expect(done.progress).toEqual(available('1', '1', '10000'))
    expect(done.coverage).toEqual({ filled: '0', applicable: '0' })
  })
})

describe('P05 deterministic exact-work preflight', () => {
  it('rejects top-level facts before reflecting over-limit keys or descriptors', () => {
    const oversized = overLimitArray<GoalEvaluationFactV1>()
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            booleanSnapshot(),
            fixedCalendar(['2026-04-01']),
            oversized.value,
          ),
        ),
      '/facts',
      'input_too_complex',
    )
    expect(oversized.boundaryReads()).toBe(0)
  })

  it.each([
    [
      'checklist items',
      (rows: readonly unknown[]) => ({
        schemaVersion: snapshotVersion,
        measurement: { kind: 'checklist', items: rows },
        checkpoints: null,
      }),
    ],
    [
      'any-of variants',
      (rows: readonly unknown[]) => ({
        schemaVersion: snapshotVersion,
        measurement: { kind: 'any_of', variants: rows },
        checkpoints: null,
      }),
    ],
    [
      'checkpoint items',
      (rows: readonly unknown[]) => ({
        schemaVersion: snapshotVersion,
        measurement: { kind: 'boolean' },
        checkpoints: { aggregation: 'independent', items: rows },
      }),
    ],
  ] as const)(
    'rejects over-limit snapshot %s before nested reflection',
    (_name, buildSnapshot) => {
      const oversized = overLimitArray<unknown>()
      expectInputIssue(
        () =>
          evaluateGoalProgress(
            input(
              buildSnapshot(
                oversized.value,
              ) as unknown as GoalEvaluationSnapshotV1,
              fixedCalendar(['2026-04-01']),
              [],
            ),
          ),
        '/facts',
        'input_too_complex',
      )
      expect(oversized.boundaryReads()).toBe(0)
    },
  )

  it.each([
    [
      'add contributions',
      (rows: readonly unknown[]): GoalEvaluationFactV1 => ({
        kind: 'fixed',
        expectationDate: '2026-04-01',
        value: { kind: 'quantity_add', contributions: rows } as never,
      }),
      {
        schemaVersion: snapshotVersion,
        measurement: {
          kind: 'quantity',
          mode: 'targeted',
          precision: 0,
          aggregation: 'add',
          target: '1',
        },
        checkpoints: null,
      },
    ],
    [
      'checklist states',
      (rows: readonly unknown[]): GoalEvaluationFactV1 => ({
        kind: 'fixed',
        expectationDate: '2026-04-01',
        value: { kind: 'checklist', items: rows } as never,
      }),
      {
        schemaVersion: snapshotVersion,
        measurement: { kind: 'checklist', items: [{ itemId: 'one' }] },
        checkpoints: null,
      },
    ],
    [
      'any-of values',
      (rows: readonly unknown[]): GoalEvaluationFactV1 => ({
        kind: 'fixed',
        expectationDate: '2026-04-01',
        value: { kind: 'any_of', variants: rows } as never,
      }),
      {
        schemaVersion: snapshotVersion,
        measurement: {
          kind: 'any_of',
          variants: [{ variantId: 'one', precision: 0, target: '1' }],
        },
        checkpoints: null,
      },
    ],
    [
      'checkpoint facts',
      (rows: readonly unknown[]): GoalEvaluationFactV1 => ({
        kind: 'fixed_checkpoints',
        expectationDate: '2026-04-01',
        checkpoints: rows as never,
      }),
      {
        schemaVersion: snapshotVersion,
        measurement: { kind: 'boolean' },
        checkpoints: {
          aggregation: 'independent',
          items: [{ checkpointId: 'one', satisfaction: { kind: 'boolean' } }],
        },
      },
    ],
  ] as const)(
    'rejects over-limit nested fact %s before nested reflection',
    (_name, buildFact, snapshot) => {
      const oversized = overLimitArray<unknown>()
      expectInputIssue(
        () =>
          evaluateGoalProgress(
            input(snapshot, fixedCalendar(['2026-04-01']), [
              buildFact(oversized.value),
            ]),
          ),
        '/facts',
        'input_too_complex',
      )
      expect(oversized.boundaryReads()).toBe(0)
    },
  )

  it('rejects over-limit P04 periods and dates before nested reflection', () => {
    const fixture = quotaCalendar(
      { kind: 'weekly', n: '2' },
      { targetMonth: '2026-06', activeLocalDate: '2026-06-01' },
    )
    if (fixture.calendar.calendar.kind !== 'quota') {
      throw new Error('expected quota fixture')
    }

    const oversizedPeriods = overLimitArray<never>()
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            booleanSnapshot(),
            mutateCalendar(fixture, {
              ...fixture.calendar.calendar,
              periods: oversizedPeriods.value,
            }),
            [],
          ),
        ),
      '/facts',
      'input_too_complex',
    )
    expect(oversizedPeriods.boundaryReads()).toBe(0)

    const oversizedDates = overLimitArray<string>()
    const [firstPeriod, ...remainingPeriods] = fixture.calendar.calendar.periods
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            booleanSnapshot(),
            mutateCalendar(fixture, {
              ...fixture.calendar.calendar,
              periods: [
                {
                  ...firstPeriod!,
                  activeDates: oversizedDates.value,
                  eligibleDates: oversizedDates.value,
                },
                ...remainingPeriods,
              ],
            }),
            [],
          ),
        ),
      '/facts',
      'input_too_complex',
    )
    expect(oversizedDates.boundaryReads()).toBe(0)
  })

  it('rejects over-limit P04 provenance weekdays before nested reflection', () => {
    const fixture = fixedCalendar(['2026-04-01'])
    const oversizedWeekdays = overLimitArray<string>()
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            booleanSnapshot(),
            {
              ...fixture,
              calendarInput: {
                ...fixture.calendarInput,
                repetition: {
                  kind: 'weekdays',
                  weekdays: oversizedWeekdays.value,
                },
              } as CalendarTargetsInput,
            },
            [],
          ),
        ),
      '/facts',
      'input_too_complex',
    )
    expect(oversizedWeekdays.boundaryReads()).toBe(0)
  })

  it('charges one shared term ledger before reflecting a later nested array', () => {
    const configuredItems = Array.from({ length: 6_000 }, (_, index) => ({
      itemId: `item-${String(index)}`,
    }))
    const factItems = observedArray(
      configuredItems.map((item) => ({ ...item, state: 'done' as const })),
    )
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            {
              schemaVersion: snapshotVersion,
              measurement: { kind: 'checklist', items: configuredItems },
              checkpoints: null,
            } as unknown as GoalEvaluationSnapshotV1,
            fixedCalendar(['2026-04-01']),
            [
              {
                kind: 'fixed',
                expectationDate: '2026-04-01',
                value: { kind: 'checklist', items: factItems.value },
              },
            ],
          ),
        ),
      '/facts',
      'input_too_complex',
    )
    expect(factItems.boundaryReads()).toBe(0)
  })
})

describe('P05 exact input and output boundary', () => {
  it('rejects nested P04 provenance mutations without invoking accessors', () => {
    const base = fixedCalendar(dates(1, 2))
    const run = (repetition: unknown): void => {
      expectInputIssue(
        () =>
          evaluateGoalProgress(
            input(
              booleanSnapshot(),
              {
                ...base,
                calendarInput: {
                  ...base.calendarInput,
                  repetition,
                } as CalendarTargetsInput,
              },
              [],
            ),
          ),
        '/calendarInput',
        repetition !== null && Object.getPrototypeOf(repetition) === null
          ? 'invalid_type'
          : Reflect.ownKeys(repetition as object).some(
                (key) => typeof key === 'symbol' || key === 'extra',
              )
            ? 'unexpected_property'
            : 'invalid_type',
      )
    }

    run({ kind: 'daily', extra: true })
    const withSymbol = { kind: 'daily' }
    Object.defineProperty(withSymbol, Symbol('extra'), { value: true })
    run(withSymbol)
    run(Object.assign(Object.create(null), { kind: 'daily' }))

    let getterReads = 0
    const withAccessor: Record<string, unknown> = {}
    Object.defineProperty(withAccessor, 'kind', {
      enumerable: true,
      get() {
        getterReads += 1
        return 'daily'
      },
    })
    run(withAccessor)
    expect(getterReads).toBe(0)

    run({ kind: 'weekdays', weekdays: new Array<string>(1) })
  })

  it('rejects nested supplied-calendar mutations without invoking accessors', () => {
    const base = quotaCalendar(
      { kind: 'weekly', n: '2' },
      { targetMonth: '2026-06', activeLocalDate: '2026-06-01' },
    )
    if (base.calendar.calendar.kind !== 'quota') {
      throw new Error('expected quota fixture')
    }
    const first = base.calendar.calendar.periods[0]!
    const remaining = base.calendar.calendar.periods.slice(1)
    const run = (period: unknown, code: string): void => {
      expectInputIssue(
        () =>
          evaluateGoalProgress(
            input(
              booleanSnapshot(),
              mutateCalendar(base, {
                ...base.calendar.calendar,
                periods: [period, ...remaining],
              }),
              [],
            ),
          ),
        '/calendar',
        code,
      )
    }

    run({ ...first, extra: true }, 'unexpected_property')
    const withSymbol = { ...first }
    Object.defineProperty(withSymbol, Symbol('extra'), { value: true })
    run(withSymbol, 'unexpected_property')
    run(Object.assign(Object.create(null), first), 'invalid_type')

    let getterReads = 0
    const withAccessor = { ...first } as Record<string, unknown>
    Object.defineProperty(withAccessor, 'cadence', {
      enumerable: true,
      get() {
        getterReads += 1
        return 'weekly'
      },
    })
    run(withAccessor, 'invalid_type')
    expect(getterReads).toBe(0)

    run({ ...first, activeDates: new Array<string>(1) }, 'invalid_type')
  })

  it('rejects nested snapshot mutations without invoking accessors', () => {
    const run = (snapshot: unknown, pointer: string, code: string): void => {
      expectInputIssue(
        () =>
          evaluateGoalProgress(
            input(
              snapshot as GoalEvaluationSnapshotV1,
              fixedCalendar(['2026-04-01']),
              [],
            ),
          ),
        pointer,
        code,
      )
    }
    const checklistBase = {
      schemaVersion: snapshotVersion,
      measurement: { kind: 'checklist', items: [{ itemId: 'one' }] },
      checkpoints: null,
    }
    run(
      {
        ...checklistBase,
        measurement: {
          kind: 'checklist',
          items: [{ itemId: 'one', extra: true }],
        },
      },
      '/snapshot/measurement',
      'unexpected_property',
    )
    const symbolItem = { itemId: 'one' }
    Object.defineProperty(symbolItem, Symbol('extra'), { value: true })
    run(
      {
        ...checklistBase,
        measurement: { kind: 'checklist', items: [symbolItem] },
      },
      '/snapshot/measurement',
      'unexpected_property',
    )
    run(
      {
        ...checklistBase,
        measurement: {
          kind: 'checklist',
          items: [Object.assign(Object.create(null), { itemId: 'one' })],
        },
      },
      '/snapshot/measurement',
      'invalid_type',
    )

    const runSatisfaction = (candidate: unknown, code: string): void => {
      run(
        {
          schemaVersion: snapshotVersion,
          measurement: { kind: 'boolean' },
          checkpoints: {
            aggregation: 'independent',
            items: [{ checkpointId: 'one', satisfaction: candidate }],
          },
        },
        '/snapshot/checkpoints',
        code,
      )
    }
    runSatisfaction({ kind: 'boolean', extra: true }, 'unexpected_property')
    const symbolSatisfaction = { kind: 'boolean' }
    Object.defineProperty(symbolSatisfaction, Symbol('extra'), { value: true })
    runSatisfaction(symbolSatisfaction, 'unexpected_property')
    runSatisfaction(
      Object.assign(Object.create(null), { kind: 'boolean' }),
      'invalid_type',
    )

    let getterReads = 0
    const satisfaction: Record<string, unknown> = {}
    Object.defineProperty(satisfaction, 'kind', {
      enumerable: true,
      get() {
        getterReads += 1
        return 'boolean'
      },
    })
    runSatisfaction(satisfaction, 'invalid_type')
    expect(getterReads).toBe(0)

    run(
      {
        schemaVersion: snapshotVersion,
        measurement: { kind: 'boolean' },
        checkpoints: {
          aggregation: 'independent',
          items: new Array(1),
        },
      },
      '/snapshot/checkpoints',
      'invalid_type',
    )
  })

  it('rejects nested fact mutations without invoking accessors', () => {
    const run = (value: unknown, code: string): void => {
      expectInputIssue(
        () =>
          evaluateGoalProgress(
            input(booleanSnapshot(), fixedCalendar(['2026-04-01']), [
              {
                kind: 'fixed',
                expectationDate: '2026-04-01',
                value,
              } as GoalEvaluationFactV1,
            ]),
          ),
        '/facts/0/value',
        code,
      )
    }
    run({ kind: 'boolean', result: 'done', extra: true }, 'unexpected_property')
    const withSymbol = { kind: 'boolean', result: 'done' }
    Object.defineProperty(withSymbol, Symbol('extra'), { value: true })
    run(withSymbol, 'unexpected_property')
    run(
      Object.assign(Object.create(null), {
        kind: 'boolean',
        result: 'done',
      }),
      'invalid_type',
    )

    let getterReads = 0
    const withAccessor: Record<string, unknown> = { result: 'done' }
    Object.defineProperty(withAccessor, 'kind', {
      enumerable: true,
      get() {
        getterReads += 1
        return 'boolean'
      },
    })
    run(withAccessor, 'invalid_type')
    expect(getterReads).toBe(0)

    const runChecklistItem = (item: unknown, code: string): void => {
      expectInputIssue(
        () =>
          evaluateGoalProgress(
            input(
              {
                schemaVersion: snapshotVersion,
                measurement: {
                  kind: 'checklist',
                  items: [{ itemId: 'one' }],
                },
                checkpoints: null,
              },
              fixedCalendar(['2026-04-01']),
              [
                {
                  kind: 'fixed',
                  expectationDate: '2026-04-01',
                  value: { kind: 'checklist', items: [item] },
                } as GoalEvaluationFactV1,
              ],
            ),
          ),
        '/facts/0/value',
        code,
      )
    }
    runChecklistItem(
      { itemId: 'one', state: 'done', extra: true },
      'unexpected_property',
    )
    const symbolChecklistItem = { itemId: 'one', state: 'done' }
    Object.defineProperty(symbolChecklistItem, Symbol('extra'), { value: true })
    runChecklistItem(symbolChecklistItem, 'unexpected_property')
    runChecklistItem(
      Object.assign(Object.create(null), {
        itemId: 'one',
        state: 'done',
      }),
      'invalid_type',
    )
    let checklistItemGetterReads = 0
    const checklistItemAccessor: Record<string, unknown> = { state: 'done' }
    Object.defineProperty(checklistItemAccessor, 'itemId', {
      enumerable: true,
      get() {
        checklistItemGetterReads += 1
        return 'one'
      },
    })
    runChecklistItem(checklistItemAccessor, 'invalid_type')
    expect(checklistItemGetterReads).toBe(0)

    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            {
              schemaVersion: snapshotVersion,
              measurement: {
                kind: 'checklist',
                items: [{ itemId: 'one' }],
              },
              checkpoints: null,
            },
            fixedCalendar(['2026-04-01']),
            [
              {
                kind: 'fixed',
                expectationDate: '2026-04-01',
                value: { kind: 'checklist', items: new Array(1) },
              },
            ],
          ),
        ),
      '/facts/0/value',
      'invalid_type',
    )
  })

  it('rejects a cyclic nested DTO with a typed finite issue', () => {
    const cyclicItem: Record<string, unknown> = { itemId: 'one' }
    cyclicItem.extra = cyclicItem
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            {
              schemaVersion: snapshotVersion,
              measurement: { kind: 'checklist', items: [cyclicItem] },
              checkpoints: null,
            } as unknown as GoalEvaluationSnapshotV1,
            fixedCalendar(['2026-04-01']),
            [],
          ),
        ),
      '/snapshot/measurement',
      'unexpected_property',
    )
  })

  it('rejects empty explicit collections that must instead be absent or not-done', () => {
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            {
              schemaVersion: snapshotVersion,
              measurement: {
                kind: 'checklist',
                items: [{ itemId: 'one' }],
              },
              checkpoints: null,
            },
            fixedCalendar(['2026-04-01']),
            [
              {
                kind: 'fixed',
                expectationDate: '2026-04-01',
                value: { kind: 'checklist', items: [] },
              },
            ],
          ),
        ),
      '/facts/0/value',
      'invalid_type',
    )

    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            {
              schemaVersion: snapshotVersion,
              measurement: { kind: 'boolean' },
              checkpoints: {
                aggregation: 'independent',
                items: [
                  {
                    checkpointId: 'one',
                    satisfaction: { kind: 'boolean' },
                  },
                ],
              },
            },
            fixedCalendar(['2026-04-01']),
            [
              {
                kind: 'fixed_checkpoints',
                expectationDate: '2026-04-01',
                checkpoints: [],
              },
            ],
          ),
        ),
      '/facts/0/checkpoints',
      'invalid_type',
    )
  })

  it('rejects forged successful P04 calendars that are not canonical snapshots', () => {
    const fixed = fixedCalendar(dates(1, 2))
    if (fixed.calendar.calendar.kind !== 'fixed') {
      throw new Error('expected fixed fixture')
    }
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            booleanSnapshot(),
            mutateCalendar(fixed, {
              ...fixed.calendar.calendar,
              expectationDates: ['2026-04-01', '2026-04-03'],
            }),
            [],
          ),
        ),
      '/calendar',
      'incompatible',
    )

    const quota = quotaCalendar(
      { kind: 'weekly', n: '2' },
      { targetMonth: '2026-06', activeLocalDate: '2026-06-01' },
    )
    if (quota.calendar.calendar.kind !== 'quota') {
      throw new Error('expected quota fixture')
    }
    const quotaCalendarValue = quota.calendar.calendar
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            booleanSnapshot(),
            mutateCalendar(quota, {
              ...quotaCalendarValue,
              periods: quotaCalendarValue.periods.slice(0, -1),
            }),
            [],
          ),
        ),
      '/calendar',
      'incompatible',
    )

    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            booleanSnapshot(),
            mutateCalendar(quota, {
              ...quotaCalendarValue,
              periods: quotaCalendarValue.periods.map((period, index) =>
                index === 0
                  ? { ...period, periodTarget: period.periodTarget + 1 }
                  : period,
              ),
            }),
            [],
          ),
        ),
      '/calendar',
      'incompatible',
    )

    const weeklyTask = weeklyTaskCalendar('1')
    if (weeklyTask.calendar.calendar.kind !== 'weekly_planned_task') {
      throw new Error('expected weekly task fixture')
    }
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            booleanSnapshot(),
            mutateCalendar(weeklyTask, {
              ...weeklyTask.calendar.calendar,
              periods: [],
            }),
            [],
          ),
        ),
      '/calendar',
      'incompatible',
    )
  })

  it('maps an ineligible P04 provenance input to a finite incompatible issue', () => {
    const fallback = fixedCalendar(['2026-04-01'])
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            booleanSnapshot(),
            {
              ...fallback,
              calendarInput: {
                targetMonth: '2026-04',
                activeLocalDate: '2026-04-01',
                timeZone,
                repetition: { kind: 'one_off', dueDate: '2026-05-01' },
              },
            },
            [],
          ),
        ),
      '/calendarInput',
      'incompatible',
    )
  })

  it('uses finite checkpoint pointers for unknown current component identities', () => {
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            {
              schemaVersion: snapshotVersion,
              measurement: { kind: 'boolean' },
              checkpoints: {
                aggregation: 'independent',
                items: [
                  {
                    checkpointId: 'known',
                    satisfaction: { kind: 'boolean' },
                  },
                ],
              },
            },
            fixedCalendar(['2026-04-01']),
            [
              {
                kind: 'fixed_checkpoints',
                expectationDate: '2026-04-01',
                checkpoints: [
                  {
                    checkpointId: 'unknown',
                    value: { kind: 'boolean', result: 'done' },
                  },
                ],
              },
            ],
          ),
        ),
      '/facts/0/checkpointId',
      'incompatible',
    )
  })

  it('rejects extra fields, non-plain objects, sparse arrays and accessors without reading them', () => {
    expectInputIssue(
      () =>
        evaluateGoalProgress({
          ...input(booleanSnapshot(), fixedCalendar(['2026-04-01']), []),
          extra: true,
        } as never),
      '',
      'unexpected_property',
    )

    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            Object.assign(Object.create(null), booleanSnapshot()) as never,
            fixedCalendar(['2026-04-01']),
            [],
          ),
        ),
      '/snapshot',
      'invalid_type',
    )

    const sparse = new Array<GoalEvaluationFactV1>(1)
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(booleanSnapshot(), fixedCalendar(['2026-04-01']), sparse),
        ),
      '/facts',
      'invalid_type',
    )

    let reads = 0
    const accessorCalendar = fixedCalendar(['2026-04-01'])
    const accessorInput: Record<string, unknown> = {
      snapshot: booleanSnapshot(),
      calendarInput: accessorCalendar.calendarInput,
      calendar: accessorCalendar.calendar,
      facts: [],
    }
    Object.defineProperty(accessorInput, 'asOfLocalDate', {
      enumerable: true,
      get() {
        reads += 1
        return '2026-04-01'
      },
    })
    expectInputIssue(
      () => evaluateGoalProgress(accessorInput as never),
      '',
      'invalid_type',
    )
    expect(reads).toBe(0)
  })

  it('rejects duplicate facts/components, wrong measurement facts and out-of-calendar facts', () => {
    const duplicateFact: GoalEvaluationFactV1 = {
      kind: 'fixed',
      expectationDate: '2026-04-01',
      value: { kind: 'boolean', result: 'done' },
    }
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(booleanSnapshot(), fixedCalendar(['2026-04-01']), [
            duplicateFact,
            duplicateFact,
          ]),
        ),
      '/facts/1/expectationDate',
      'incompatible',
    )
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(booleanSnapshot(), fixedCalendar(['2026-04-01']), [
            {
              kind: 'fixed',
              expectationDate: '2026-04-01',
              value: { kind: 'quantity_latest', value: '1' },
            },
          ]),
        ),
      '/facts/0/value',
      'incompatible',
    )
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(booleanSnapshot(), fixedCalendar(['2026-04-01']), [
            {
              kind: 'fixed',
              expectationDate: '2026-04-02',
              value: { kind: 'boolean', result: 'done' },
            },
          ]),
        ),
      '/facts/0/expectationDate',
      'incompatible',
    )

    const quantitySnapshot: GoalEvaluationSnapshotV1 = {
      schemaVersion: snapshotVersion,
      measurement: {
        kind: 'quantity',
        mode: 'targeted',
        precision: 0,
        aggregation: 'add',
        target: '10',
      },
      checkpoints: null,
    }
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(quantitySnapshot, fixedCalendar(['2026-04-01']), [
            {
              kind: 'fixed',
              expectationDate: '2026-04-01',
              value: {
                kind: 'quantity_add',
                contributions: [
                  { contributionId: 'same', value: '1' },
                  { contributionId: 'same', value: '2' },
                ],
              },
            },
          ]),
        ),
      '/facts/0/value',
      'incompatible',
    )

    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(quantitySnapshot, fixedCalendar(['2026-04-01', '2026-04-02']), [
            {
              kind: 'fixed',
              expectationDate: '2026-04-01',
              value: {
                kind: 'quantity_add',
                contributions: [
                  { contributionId: 'same-across-dates', value: '1' },
                ],
              },
            },
            {
              kind: 'fixed',
              expectationDate: '2026-04-02',
              value: {
                kind: 'quantity_add',
                contributions: [
                  { contributionId: 'same-across-dates', value: '2' },
                ],
              },
            },
          ]),
        ),
      '/facts/1/value',
      'incompatible',
    )
  })

  it('rejects duplicate snapshot IDs, unknown component facts and calendar-kind mismatch', () => {
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            {
              schemaVersion: snapshotVersion,
              measurement: {
                kind: 'checklist',
                items: [{ itemId: 'a' }, { itemId: 'a' }],
              },
              checkpoints: null,
            },
            fixedCalendar(['2026-04-01']),
            [],
          ),
        ),
      '/snapshot/measurement',
      'incompatible',
    )

    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            {
              schemaVersion: snapshotVersion,
              measurement: { kind: 'checklist', items: [{ itemId: 'a' }] },
              checkpoints: null,
            },
            fixedCalendar(['2026-04-01']),
            [
              {
                kind: 'fixed',
                expectationDate: '2026-04-01',
                value: {
                  kind: 'checklist',
                  items: [{ itemId: 'b', state: 'done' }],
                },
              },
            ],
          ),
        ),
      '/facts/0/value',
      'incompatible',
    )

    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            {
              schemaVersion: snapshotVersion,
              measurement: {
                kind: 'quantity',
                mode: 'targeted',
                precision: 0,
                aggregation: 'latest',
                target: '1',
              },
              checkpoints: null,
            },
            weeklyTaskCalendar('1'),
            [],
          ),
        ),
      '/calendar',
      'incompatible',
    )
  })

  it('requires snapshot component identities to be unique across families', () => {
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            {
              schemaVersion: snapshotVersion,
              measurement: {
                kind: 'checklist',
                items: [{ itemId: 'shared-component' }],
              },
              checkpoints: {
                aggregation: 'independent',
                items: [
                  {
                    checkpointId: 'shared-component',
                    satisfaction: { kind: 'checklist' },
                  },
                ],
              },
            },
            fixedCalendar(['2026-04-01']),
            [],
          ),
        ),
      '/snapshot/checkpoints',
      'incompatible',
    )

    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            {
              schemaVersion: snapshotVersion,
              measurement: {
                kind: 'any_of',
                variants: [
                  {
                    variantId: 'shared-component',
                    precision: 0,
                    target: '1',
                  },
                ],
              },
              checkpoints: {
                aggregation: 'all',
                items: [
                  {
                    checkpointId: 'shared-component',
                    satisfaction: { kind: 'any_of' },
                  },
                ],
              },
            },
            fixedCalendar(['2026-04-01']),
            [],
          ),
        ),
      '/snapshot/checkpoints',
      'incompatible',
    )
  })

  it('is exact for huge caller decimals without Number drift', () => {
    const huge = '9'.repeat(100_000)
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            precision: 0,
            aggregation: 'latest',
            target: huge,
          },
          checkpoints: null,
        },
        fixedCalendar(['2026-04-01']),
        [
          {
            kind: 'fixed',
            expectationDate: '2026-04-01',
            value: { kind: 'quantity_latest', value: huge },
          },
        ],
      ),
    )
    expect(result.progress).toEqual(available('1', '1', '10000'))
  })

  it('fully reduces goal ratios beyond the safe-integer fast path', () => {
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            precision: 0,
            aggregation: 'latest',
            target: '20000000000000004',
          },
          checkpoints: null,
        },
        fixedCalendar(['2026-04-01']),
        [
          {
            kind: 'fixed',
            expectationDate: '2026-04-01',
            value: {
              kind: 'quantity_latest',
              value: '10000000000000002',
            },
          },
        ],
      ),
    )
    expect(result.progress).toEqual(available('1', '2', '5000'))
  })

  it('compares distinct huge any-of ratios exactly within the work budget', () => {
    const zeros = '0'.repeat(1_000)
    const firstValue = `3${'0'.repeat(999)}1`
    const secondValue = `4${'0'.repeat(999)}1`
    const result = evaluateGoalProgress(
      input(
        {
          schemaVersion: snapshotVersion,
          measurement: {
            kind: 'any_of',
            variants: [
              { variantId: 'first', precision: 0, target: `7${zeros}` },
              { variantId: 'second', precision: 0, target: `9${zeros}` },
            ],
          },
          checkpoints: null,
        },
        fixedCalendar(['2026-04-01']),
        [
          {
            kind: 'fixed',
            expectationDate: '2026-04-01',
            value: {
              kind: 'any_of',
              variants: [
                { variantId: 'first', value: firstValue },
                { variantId: 'second', value: secondValue },
              ],
            },
          },
        ],
      ),
    )

    expect(result.progress).toEqual(available(secondValue, `9${zeros}`, '4444'))
  })

  it('rejects goal exact work over the deterministic public budget', () => {
    const oversized = '9'.repeat(130_000)
    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(
            {
              schemaVersion: snapshotVersion,
              measurement: {
                kind: 'quantity',
                mode: 'targeted',
                precision: 0,
                aggregation: 'latest',
                target: oversized,
              },
              checkpoints: null,
            },
            fixedCalendar(['2026-04-01']),
            [
              {
                kind: 'fixed',
                expectationDate: '2026-04-01',
                value: { kind: 'quantity_latest', value: oversized },
              },
            ],
          ),
        ),
      '/facts',
      'input_too_complex',
    )
  })

  it('charges component terms to the deterministic public work budget', () => {
    const oversizedChecklist = {
      schemaVersion: snapshotVersion,
      measurement: {
        kind: 'checklist',
        items: Array.from({ length: 10_001 }, (_, index) => ({
          itemId: `item-${String(index)}`,
        })),
      },
      checkpoints: null,
    } as unknown as GoalEvaluationSnapshotV1

    expectInputIssue(
      () =>
        evaluateGoalProgress(
          input(oversizedChecklist, fixedCalendar(['2026-04-01']), []),
        ),
      '/facts',
      'input_too_complex',
    )
  })

  it('returns a detached recursively frozen graph and frozen finite errors', () => {
    const mutableFacts: GoalEvaluationFactV1[] = [
      {
        kind: 'fixed',
        expectationDate: '2026-04-01',
        value: { kind: 'boolean', result: 'done' },
      },
    ]
    const result = evaluateGoalProgress(
      input(booleanSnapshot(), fixedCalendar(['2026-04-01']), mutableFacts),
    )
    mutableFacts.length = 0
    expect(result.progress).toEqual(available('1', '1', '10000'))
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.formulaVersions)).toBe(true)
    expect(Object.isFrozen(result.progress)).toBe(true)
    expect(Object.isFrozen(result.progress.exact)).toBe(true)
    expect(Object.isFrozen(result.contribution)).toBe(true)
    expect(Object.isFrozen(result.periods)).toBe(true)

    try {
      evaluateGoalProgress({} as never)
      throw new Error('expected GoalEvaluationInputError')
    } catch (error) {
      expect(error).toBeInstanceOf(GoalEvaluationInputError)
      if (error instanceof GoalEvaluationInputError) {
        expect(Object.isFrozen(error)).toBe(true)
        expect(Object.isFrozen(error.issues)).toBe(true)
        expect(Object.isFrozen(error.issues[0])).toBe(true)
      }
    }
  })
})
