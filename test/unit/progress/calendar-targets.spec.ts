import {
  CALENDAR_TARGETS_FORMULA_VERSION,
  CalendarTargetsInputError,
  calculateEligibleCalendar,
  calculateExpectedPace,
  calculatePeriodTarget,
  type CalendarRepetitionV1,
  type CalendarTargetsInput,
  type QuotaCalendarPeriod,
} from '@/modules/progress'
import type { DraftGoalConfigV1, GoalConfigV1 } from '@/modules/planning'

const timeZone = 'Asia/Yekaterinburg' as const

describe('P04 planning-to-progress compile-time seam', () => {
  it('accepts refined repetition structurally but rejects an unchecked draft', () => {
    type IsExact<Left, Right> = [Left] extends [Right]
      ? [Right] extends [Left]
        ? true
        : false
      : false
    const acceptCompleteProgressRepetition = (
      value: CalendarRepetitionV1,
    ): void => {
      void value
    }
    const acceptRefinedPlanningRepetition: (
      value: GoalConfigV1['repetition'],
    ) => void = acceptCompleteProgressRepetition

    // @ts-expect-error Draft repetitions retain nullable incomplete leaves.
    const rejectUncheckedDraftRepetition: (
      value: DraftGoalConfigV1['repetition'],
    ) => void = acceptCompleteProgressRepetition
    const refinedStillNeedsExactProjection: IsExact<
      GoalConfigV1['repetition'],
      CalendarRepetitionV1
    > = false

    expect(acceptRefinedPlanningRepetition).toBe(
      acceptCompleteProgressRepetition,
    )
    expect(rejectUncheckedDraftRepetition).toBe(
      acceptCompleteProgressRepetition,
    )
    expect(refinedStillNeedsExactProjection).toBe(false)
  })
})

function calendar(
  repetition: CalendarTargetsInput['repetition'],
  overrides: Partial<Omit<CalendarTargetsInput, 'repetition'>> = {},
): ReturnType<typeof calculateEligibleCalendar> {
  return calculateEligibleCalendar({
    targetMonth: '2026-04',
    activeLocalDate: '2026-04-01',
    timeZone,
    repetition,
    ...overrides,
  })
}

function expectInputIssue(
  action: () => unknown,
  pointer: string,
  code: string,
): void {
  try {
    action()
    throw new Error('expected CalendarTargetsInputError')
  } catch (error) {
    expect(error).toBeInstanceOf(CalendarTargetsInputError)
    expect((error as CalendarTargetsInputError).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ pointer, code })]),
    )
  }
}

function quotaPeriods(
  result: ReturnType<typeof calculateEligibleCalendar>,
): readonly QuotaCalendarPeriod[] {
  if (!result.eligible || result.calendar.kind !== 'quota') {
    throw new Error('expected eligible quota calendar')
  }
  return result.calendar.periods
}

describe('P04 exact period target arithmetic', () => {
  it('uses exact half-up arithmetic around a tie', () => {
    expect(
      calculatePeriodTarget({
        n: '2',
        periodDays: 100,
        activeDays: 74,
        eligibleDays: 74,
      }),
    ).toBe(1)
    expect(
      calculatePeriodTarget({
        n: '2',
        periodDays: 100,
        activeDays: 75,
        eligibleDays: 75,
      }),
    ).toBe(2)
    expect(
      calculatePeriodTarget({
        n: '2',
        periodDays: 100,
        activeDays: 76,
        eligibleDays: 76,
      }),
    ).toBe(2)
  })

  it('proves weekly proration, zero branches, minimum and eligible cap', () => {
    expect(
      calculatePeriodTarget({
        n: '3',
        periodDays: 7,
        activeDays: 5,
        eligibleDays: 5,
      }),
    ).toBe(2)
    expect(
      calculatePeriodTarget({
        n: '3',
        periodDays: 7,
        activeDays: 3,
        eligibleDays: 3,
      }),
    ).toBe(1)
    expect(
      calculatePeriodTarget({
        n: '1',
        periodDays: 7,
        activeDays: 1,
        eligibleDays: 1,
      }),
    ).toBe(1)
    expect(
      calculatePeriodTarget({
        n: '99',
        periodDays: 7,
        activeDays: 3,
        eligibleDays: 3,
      }),
    ).toBe(3)
    expect(
      calculatePeriodTarget({
        n: '3',
        periodDays: 7,
        activeDays: 0,
        eligibleDays: 0,
      }),
    ).toBe(0)
    expect(
      calculatePeriodTarget({
        n: '3',
        periodDays: 7,
        activeDays: 3,
        eligibleDays: 0,
      }),
    ).toBe(0)
  })

  it('uses active days in the numerator before capping to eligible days', () => {
    expect(
      calculatePeriodTarget({
        n: '3',
        periodDays: 7,
        activeDays: 5,
        eligibleDays: 2,
      }),
    ).toBe(2)
  })

  it('saturates an arbitrarily long n without converting the whole decimal', () => {
    expect(
      calculatePeriodTarget({
        n: '9'.repeat(100_000),
        periodDays: 366,
        activeDays: 1,
        eligibleDays: 1,
      }),
    ).toBe(1)
  })

  it.each([
    [{ n: '0', periodDays: 7, activeDays: 1, eligibleDays: 1 }, '/n'],
    [{ n: '01', periodDays: 7, activeDays: 1, eligibleDays: 1 }, '/n'],
    [{ n: '1e2', periodDays: 7, activeDays: 1, eligibleDays: 1 }, '/n'],
    [{ n: '1', periodDays: 0, activeDays: 0, eligibleDays: 0 }, '/periodDays'],
    [
      { n: '1', periodDays: 367, activeDays: 1, eligibleDays: 1 },
      '/periodDays',
    ],
    [{ n: '1', periodDays: 7, activeDays: 8, eligibleDays: 1 }, '/activeDays'],
    [
      { n: '1', periodDays: 7, activeDays: 2, eligibleDays: 3 },
      '/eligibleDays',
    ],
    [
      { n: '1', periodDays: 7, activeDays: 1, eligibleDays: 1, extra: true },
      '',
    ],
  ] as const)('rejects malformed target input %#', (input, pointer) => {
    expectInputIssue(
      () => calculatePeriodTarget(input),
      pointer,
      pointer === '' ? 'unexpected_property' : 'invalid_value',
    )
  })
})

describe('P04 eligible calendars', () => {
  it('returns all five April 2026 Monday-Sunday segments independently', () => {
    const periods = quotaPeriods(calendar({ kind: 'weekly', n: '3' }))

    expect(
      periods.map((period) => ({
        ordinal: period.ordinal,
        start: period.periodStart,
        end: period.periodEnd,
        periodDays: period.periodDays,
        activeDays: period.activeDates.length,
        target: period.periodTarget,
      })),
    ).toEqual([
      {
        ordinal: 1,
        start: '2026-04-01',
        end: '2026-04-05',
        periodDays: 7,
        activeDays: 5,
        target: 2,
      },
      {
        ordinal: 2,
        start: '2026-04-06',
        end: '2026-04-12',
        periodDays: 7,
        activeDays: 7,
        target: 3,
      },
      {
        ordinal: 3,
        start: '2026-04-13',
        end: '2026-04-19',
        periodDays: 7,
        activeDays: 7,
        target: 3,
      },
      {
        ordinal: 4,
        start: '2026-04-20',
        end: '2026-04-26',
        periodDays: 7,
        activeDays: 7,
        target: 3,
      },
      {
        ordinal: 5,
        start: '2026-04-27',
        end: '2026-04-30',
        periodDays: 7,
        activeDays: 4,
        target: 2,
      },
    ])
  })

  it('returns deterministic target-zero pre-activation weeks without debt carry', () => {
    const periods = quotaPeriods(
      calendar({ kind: 'weekly', n: '3' }, { activeLocalDate: '2026-04-20' }),
    )

    expect(periods.map((period) => period.periodTarget)).toEqual([
      0, 0, 0, 3, 2,
    ])
    expect(periods.slice(0, 3).map((period) => period.eligibleDates)).toEqual([
      [],
      [],
      [],
    ])
    expect(periods[3]?.periodTarget).toBe(3)
  })

  it('has six August segments and maps weekly task ordinal five to Aug 24-30', () => {
    const sixPeriods = quotaPeriods(
      calendar(
        { kind: 'weekly', n: '1' },
        { targetMonth: '2026-08', activeLocalDate: '2026-08-01' },
      ),
    )
    expect(
      sixPeriods.map(({ periodStart, periodEnd }) => [periodStart, periodEnd]),
    ).toEqual([
      ['2026-08-01', '2026-08-02'],
      ['2026-08-03', '2026-08-09'],
      ['2026-08-10', '2026-08-16'],
      ['2026-08-17', '2026-08-23'],
      ['2026-08-24', '2026-08-30'],
      ['2026-08-31', '2026-08-31'],
    ])

    const task = calendar(
      { kind: 'weekly_planned_task', weekOrdinal: '5' },
      { targetMonth: '2026-08', activeLocalDate: '2026-08-01' },
    )
    expect(task).toEqual({
      formulaVersion: CALENDAR_TARGETS_FORMULA_VERSION,
      eligible: true,
      calendar: {
        kind: 'weekly_planned_task',
        targetMonth: '2026-08',
        activeLocalDate: '2026-08-01',
        timeZone,
        periods: [
          {
            cadence: 'weekly',
            ordinal: 5,
            periodStart: '2026-08-24',
            periodEnd: '2026-08-30',
            periodTarget: 1,
          },
        ],
      },
      issues: [],
    })
  })

  it('reports a missing weekly task ordinal as calendar incompatibility', () => {
    const result = calendar(
      { kind: 'weekly_planned_task', weekOrdinal: '5' },
      { targetMonth: '2027-02', activeLocalDate: '2027-02-01' },
    )

    expect(result).toEqual({
      formulaVersion: CALENDAR_TARGETS_FORMULA_VERSION,
      eligible: false,
      calendar: null,
      issues: [
        {
          pointer: '/repetition/weekOrdinal',
          code: 'incompatible',
          detail: 'week ordinal is not present in target month',
        },
      ],
    })
  })

  it('makes a selected task week before activation not applicable', () => {
    const result = calendar(
      { kind: 'weekly_planned_task', weekOrdinal: '1' },
      { activeLocalDate: '2026-04-20' },
    )
    expect(result.eligible).toBe(true)
    expect(
      result.eligible && result.calendar.kind === 'weekly_planned_task'
        ? result.calendar.periods
        : null,
    ).toEqual([])
  })

  it('keeps one week-level task when activation intersects the selected segment', () => {
    const result = calendar(
      { kind: 'weekly_planned_task', weekOrdinal: '3' },
      { activeLocalDate: '2026-04-15' },
    )
    expect(
      result.eligible && result.calendar.kind === 'weekly_planned_task'
        ? result.calendar.periods
        : null,
    ).toEqual([
      {
        cadence: 'weekly',
        ordinal: 3,
        periodStart: '2026-04-13',
        periodEnd: '2026-04-19',
        periodTarget: 1,
      },
    ])
  })

  it('prorates one late monthly quota to five', () => {
    const periods = quotaPeriods(
      calendar({ kind: 'monthly', n: '10' }, { activeLocalDate: '2026-04-15' }),
    )

    expect(periods).toHaveLength(1)
    expect(periods[0]).toMatchObject({
      cadence: 'monthly',
      ordinal: 1,
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      periodDays: 30,
      periodTarget: 5,
    })
    expect(periods[0]?.activeDates).toHaveLength(16)
    expect(periods[0]?.eligibleDates).toEqual(periods[0]?.activeDates)
  })

  it('enumerates exact daily and canonical selected-weekday dates', () => {
    const daily = calendar(
      { kind: 'daily' },
      { targetMonth: '2026-02', activeLocalDate: '2026-02-27' },
    )
    expect(
      daily.eligible && daily.calendar.kind === 'fixed'
        ? daily.calendar.expectationDates
        : null,
    ).toEqual(['2026-02-27', '2026-02-28'])

    const weekdays = calendar(
      { kind: 'weekdays', weekdays: ['mon', 'wed', 'sun'] },
      { activeLocalDate: '2026-04-20' },
    )
    expect(
      weekdays.eligible && weekdays.calendar.kind === 'fixed'
        ? weekdays.calendar.expectationDates
        : null,
    ).toEqual([
      '2026-04-20',
      '2026-04-22',
      '2026-04-26',
      '2026-04-27',
      '2026-04-29',
    ])
  })

  it('distinguishes active, pre-active and outside-month one-off dates', () => {
    const active = calendar({ kind: 'one_off', dueDate: '2026-04-20' })
    expect(
      active.eligible && active.calendar.kind === 'fixed'
        ? active.calendar.expectationDates
        : null,
    ).toEqual(['2026-04-20'])

    const preActive = calendar(
      { kind: 'one_off', dueDate: '2026-04-19' },
      { activeLocalDate: '2026-04-20' },
    )
    expect(
      preActive.eligible && preActive.calendar.kind === 'fixed'
        ? preActive.calendar.expectationDates
        : null,
    ).toEqual([])

    expect(calendar({ kind: 'one_off', dueDate: '2026-05-01' })).toEqual({
      formulaVersion: CALENDAR_TARGETS_FORMULA_VERSION,
      eligible: false,
      calendar: null,
      issues: [
        {
          pointer: '/repetition/dueDate',
          code: 'incompatible',
          detail: 'due date is outside target month',
        },
      ],
    })
  })

  it('emits one-off exactly on activation', () => {
    const result = calendar(
      { kind: 'one_off', dueDate: '2026-04-20' },
      { activeLocalDate: '2026-04-20' },
    )
    expect(
      result.eligible && result.calendar.kind === 'fixed'
        ? result.calendar.expectationDates
        : null,
    ).toEqual(['2026-04-20'])
  })

  it.each(['2026-04-13', '2026-04-19'] as const)(
    'keeps a weekly task when activation is the selected period boundary %s',
    (activeLocalDate) => {
      const result = calendar(
        { kind: 'weekly_planned_task', weekOrdinal: '3' },
        { activeLocalDate },
      )
      expect(
        result.eligible && result.calendar.kind === 'weekly_planned_task'
          ? result.calendar.periods
          : null,
      ).toEqual([
        {
          cadence: 'weekly',
          ordinal: 3,
          periodStart: '2026-04-13',
          periodEnd: '2026-04-19',
          periodTarget: 1,
        },
      ])
    },
  )

  it('implements proleptic Gregorian leap, century and edge-year dates', () => {
    const daysIn = (
      targetMonth: string,
      activeLocalDate: string,
    ): number | undefined =>
      quotaPeriods(
        calendar({ kind: 'monthly', n: '1' }, { targetMonth, activeLocalDate }),
      )[0]?.eligibleDates.length

    expect(daysIn('2000-02', '2000-02-01')).toBe(29)
    expect(daysIn('1900-02', '1900-02-01')).toBe(28)
    expect(daysIn('0001-01', '0001-01-01')).toBe(31)
    expect(daysIn('9999-12', '9999-12-01')).toBe(31)

    const firstMonday = calendar(
      { kind: 'weekdays', weekdays: ['mon'] },
      { targetMonth: '0001-01', activeLocalDate: '0001-01-01' },
    )
    expect(
      firstMonday.eligible && firstMonday.calendar.kind === 'fixed'
        ? firstMonday.calendar.expectationDates[0]
        : null,
    ).toBe('0001-01-01')
  })

  it.each([
    [
      {
        targetMonth: '2026-13',
        activeLocalDate: '2026-01-01',
        timeZone,
        repetition: { kind: 'daily' },
      },
      '/targetMonth',
    ],
    [
      {
        targetMonth: '2026-02',
        activeLocalDate: '1900-02-29',
        timeZone,
        repetition: { kind: 'daily' },
      },
      '/activeLocalDate',
    ],
    [
      {
        targetMonth: '2026-02',
        activeLocalDate: '2026-01-31',
        timeZone,
        repetition: { kind: 'daily' },
      },
      '/activeLocalDate',
    ],
    [
      {
        targetMonth: '2026-02',
        activeLocalDate: '2026-02-01',
        timeZone: 'UTC',
        repetition: { kind: 'daily' },
      },
      '/timeZone',
    ],
    [
      {
        targetMonth: '2026-02',
        activeLocalDate: '2026-02-01',
        timeZone,
        repetition: { kind: 'weekdays', weekdays: ['wed', 'mon'] },
      },
      '/repetition/weekdays',
    ],
    [
      {
        targetMonth: '2026-02',
        activeLocalDate: '2026-02-01',
        timeZone,
        repetition: { kind: 'daily', extra: true },
      },
      '/repetition',
    ],
  ] as const)('rejects malformed calendar input %#', (input, pointer) => {
    expectInputIssue(
      () => calculateEligibleCalendar(input as never),
      pointer,
      pointer === '/repetition' ? 'unexpected_property' : 'invalid_value',
    )
  })

  it.each([
    [{ kind: 'unknown' }, '/repetition/kind', 'invalid_value'],
    [{ kind: 'weekly', n: '01' }, '/repetition/n', 'invalid_value'],
    [{ kind: 'monthly', n: 2 }, '/repetition/n', 'invalid_type'],
    [
      { kind: 'one_off', dueDate: '2026-02-30' },
      '/repetition/dueDate',
      'invalid_value',
    ],
    [
      { kind: 'weekly_planned_task', weekOrdinal: '6' },
      '/repetition/weekOrdinal',
      'invalid_value',
    ],
  ] as const)(
    'rejects malformed repetition branch %#',
    (repetition, pointer, code) => {
      expectInputIssue(() => calendar(repetition as never), pointer, code)
    },
  )

  it('rejects a non-plain accessor input without invoking it', () => {
    let reads = 0
    const input = Object.create(null) as Record<string, unknown>
    Object.defineProperty(input, 'targetMonth', {
      enumerable: true,
      get() {
        reads += 1
        return '2026-04'
      },
    })
    input.activeLocalDate = '2026-04-01'
    input.timeZone = timeZone
    input.repetition = { kind: 'daily' }

    expectInputIssue(
      () => calculateEligibleCalendar(input as never),
      '',
      'invalid_type',
    )
    expect(reads).toBe(0)
  })

  it('never invokes ordinary-object top-level or repetition accessors', () => {
    let topLevelReads = 0
    const topLevelInput: Record<string, unknown> = {
      activeLocalDate: '2026-04-01',
      timeZone,
      repetition: { kind: 'daily' },
    }
    Object.defineProperty(topLevelInput, 'targetMonth', {
      enumerable: true,
      get() {
        topLevelReads += 1
        return '2026-04'
      },
    })
    expectInputIssue(
      () => calculateEligibleCalendar(topLevelInput as never),
      '',
      'invalid_type',
    )
    expect(topLevelReads).toBe(0)

    let repetitionReads = 0
    const repetition: Record<string, unknown> = { kind: 'weekly' }
    Object.defineProperty(repetition, 'n', {
      enumerable: true,
      get() {
        repetitionReads += 1
        return '3'
      },
    })
    expectInputIssue(
      () =>
        calculateEligibleCalendar({
          targetMonth: '2026-04',
          activeLocalDate: '2026-04-01',
          timeZone,
          repetition,
        } as never),
      '/repetition',
      'invalid_type',
    )
    expect(repetitionReads).toBe(0)
  })

  it('returns a recursively frozen detached result', () => {
    const mutableWeekdays = ['mon', 'wed'] as ('mon' | 'wed')[]
    const result = calendar({ kind: 'weekdays', weekdays: mutableWeekdays })
    mutableWeekdays.push('mon')

    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.issues)).toBe(true)
    expect(result.eligible).toBe(true)
    if (result.eligible) {
      expect(Object.isFrozen(result.calendar)).toBe(true)
      expect(result.calendar.kind).toBe('fixed')
      if (result.calendar.kind === 'fixed') {
        expect(Object.isFrozen(result.calendar.expectationDates)).toBe(true)
        expect(result.calendar.expectationDates).toContain('2026-04-06')
      }
    }

    const quota = calendar({ kind: 'weekly', n: '3' })
    expect(quota.eligible).toBe(true)
    if (quota.eligible && quota.calendar.kind === 'quota') {
      expect(Object.isFrozen(quota.calendar.periods)).toBe(true)
      expect(Object.isFrozen(quota.calendar.periods[0])).toBe(true)
      expect(Object.isFrozen(quota.calendar.periods[0]?.activeDates)).toBe(true)
    }
  })

  it('freezes both blocker data and thrown finite input issues', () => {
    const blocker = calendar({ kind: 'one_off', dueDate: '2026-05-01' })
    expect(Object.isFrozen(blocker)).toBe(true)
    expect(Object.isFrozen(blocker.issues)).toBe(true)
    expect(Object.isFrozen(blocker.issues[0])).toBe(true)

    try {
      calendar({ kind: 'weekly', n: '01' } as never)
      throw new Error('expected CalendarTargetsInputError')
    } catch (error) {
      expect(error).toBeInstanceOf(CalendarTargetsInputError)
      if (error instanceof CalendarTargetsInputError) {
        expect(Object.isFrozen(error.issues)).toBe(true)
        expect(Object.isFrozen(error.issues[0])).toBe(true)
      }
    }
  })
})

describe('P04 expected quota pace', () => {
  const period: QuotaCalendarPeriod = {
    cadence: 'weekly',
    ordinal: 1,
    periodStart: '2026-04-01',
    periodEnd: '2026-04-05',
    periodDays: 7,
    activeDates: [
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
      '2026-04-04',
      '2026-04-05',
    ],
    eligibleDates: [
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
      '2026-04-04',
      '2026-04-05',
    ],
    periodTarget: 2,
  }

  it('is inclusive and clamps before, inside and after the quota period', () => {
    expect(calculateExpectedPace({ period, asOfLocalDate: '2026-03-31' })).toBe(
      0,
    )
    expect(calculateExpectedPace({ period, asOfLocalDate: '2026-04-01' })).toBe(
      0,
    )
    expect(calculateExpectedPace({ period, asOfLocalDate: '2026-04-02' })).toBe(
      1,
    )
    expect(calculateExpectedPace({ period, asOfLocalDate: '2026-04-03' })).toBe(
      1,
    )
    expect(calculateExpectedPace({ period, asOfLocalDate: '2026-04-05' })).toBe(
      2,
    )
    expect(calculateExpectedPace({ period, asOfLocalDate: '2026-05-01' })).toBe(
      2,
    )
  })

  it('returns zero for an empty target-zero quota period', () => {
    expect(
      calculateExpectedPace({
        period: {
          ...period,
          activeDates: [],
          eligibleDates: [],
          periodTarget: 0,
        },
        asOfLocalDate: '2026-04-03',
      }),
    ).toBe(0)
  })

  it('counts the first active day inclusively at an exact pace half tie', () => {
    const latePeriod: QuotaCalendarPeriod = {
      ...period,
      activeDates: ['2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05'],
      eligibleDates: ['2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05'],
    }
    expect(
      calculateExpectedPace({
        period: latePeriod,
        asOfLocalDate: '2026-04-01',
      }),
    ).toBe(0)
    expect(
      calculateExpectedPace({
        period: latePeriod,
        asOfLocalDate: '2026-04-02',
      }),
    ).toBe(1)
  })

  it('calculates a generated monthly period before, at start, inside, at end and after', () => {
    const monthlyPeriod = quotaPeriods(
      calendar({ kind: 'monthly', n: '10' }),
    )[0]!

    expect(
      calculateExpectedPace({
        period: monthlyPeriod,
        asOfLocalDate: '2026-03-31',
      }),
    ).toBe(0)
    expect(
      calculateExpectedPace({
        period: monthlyPeriod,
        asOfLocalDate: '2026-04-01',
      }),
    ).toBe(0)
    expect(
      calculateExpectedPace({
        period: monthlyPeriod,
        asOfLocalDate: '2026-04-15',
      }),
    ).toBe(5)
    expect(
      calculateExpectedPace({
        period: monthlyPeriod,
        asOfLocalDate: '2026-04-30',
      }),
    ).toBe(10)
    expect(
      calculateExpectedPace({
        period: monthlyPeriod,
        asOfLocalDate: '2026-05-01',
      }),
    ).toBe(10)
  })

  it('paces a generated late monthly period from activation through month end', () => {
    const monthlyPeriod = quotaPeriods(
      calendar({ kind: 'monthly', n: '10' }, { activeLocalDate: '2026-04-15' }),
    )[0]!

    expect(
      calculateExpectedPace({
        period: monthlyPeriod,
        asOfLocalDate: '2026-04-14',
      }),
    ).toBe(0)
    expect(
      calculateExpectedPace({
        period: monthlyPeriod,
        asOfLocalDate: '2026-04-15',
      }),
    ).toBe(0)
    expect(
      calculateExpectedPace({
        period: monthlyPeriod,
        asOfLocalDate: '2026-04-22',
      }),
    ).toBe(3)
    expect(
      calculateExpectedPace({
        period: monthlyPeriod,
        asOfLocalDate: '2026-04-30',
      }),
    ).toBe(5)
    expect(
      calculateExpectedPace({
        period: monthlyPeriod,
        asOfLocalDate: '2026-05-01',
      }),
    ).toBe(5)
  })

  it('rejects malformed monthly identity, bounds and denominator', () => {
    const monthlyPeriod = quotaPeriods(
      calendar({ kind: 'monthly', n: '10' }),
    )[0]!

    for (const candidate of [
      { ...monthlyPeriod, ordinal: 2 },
      { ...monthlyPeriod, periodStart: '2026-04-02' },
      { ...monthlyPeriod, periodEnd: '2026-04-29' },
      { ...monthlyPeriod, periodDays: 29 },
    ]) {
      expectInputIssue(
        () =>
          calculateExpectedPace({
            period: candidate,
            asOfLocalDate: '2026-04-15',
          }),
        '/period',
        'invalid_value',
      )
    }
  })

  it('rejects malformed as-of and active/eligible disagreement', () => {
    expectInputIssue(
      () =>
        calculateExpectedPace({
          period,
          asOfLocalDate: '2026-02-30',
        }),
      '/asOfLocalDate',
      'invalid_value',
    )
    expectInputIssue(
      () =>
        calculateExpectedPace({
          period: {
            ...period,
            eligibleDates: period.eligibleDates.slice(1),
          },
          asOfLocalDate: '2026-04-03',
        }),
      '/period/eligibleDates',
      'invalid_value',
    )
  })

  it('never invokes ordinary-object accessors in target or pace inputs', () => {
    let targetReads = 0
    const targetInput: Record<string, unknown> = {
      periodDays: 7,
      activeDays: 5,
      eligibleDays: 5,
    }
    Object.defineProperty(targetInput, 'n', {
      enumerable: true,
      get() {
        targetReads += 1
        return '3'
      },
    })
    expectInputIssue(
      () => calculatePeriodTarget(targetInput as never),
      '',
      'invalid_type',
    )
    expect(targetReads).toBe(0)

    let paceReads = 0
    const paceInput: Record<string, unknown> = {
      asOfLocalDate: '2026-04-03',
    }
    Object.defineProperty(paceInput, 'period', {
      enumerable: true,
      get() {
        paceReads += 1
        return period
      },
    })
    expectInputIssue(
      () => calculateExpectedPace(paceInput as never),
      '',
      'invalid_type',
    )
    expect(paceReads).toBe(0)

    let periodReads = 0
    const accessorPeriod: Record<string, unknown> = {
      cadence: period.cadence,
      ordinal: period.ordinal,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      periodDays: period.periodDays,
      activeDates: period.activeDates,
      periodTarget: period.periodTarget,
    }
    Object.defineProperty(accessorPeriod, 'eligibleDates', {
      enumerable: true,
      get() {
        periodReads += 1
        return period.eligibleDates
      },
    })
    expectInputIssue(
      () =>
        calculateExpectedPace({
          period: accessorPeriod as never,
          asOfLocalDate: '2026-04-03',
        }),
      '/period',
      'invalid_type',
    )
    expect(periodReads).toBe(0)
  })

  it.each([
    [{ ...period, cadence: 'daily' }, '/period/cadence'],
    [
      {
        ...period,
        eligibleDates: ['2026-04-02', '2026-04-01'],
        activeDates: ['2026-04-02', '2026-04-01'],
      },
      '/period/eligibleDates',
    ],
    [
      {
        ...period,
        eligibleDates: ['2026-04-01', '2026-04-01'],
        activeDates: ['2026-04-01', '2026-04-01'],
      },
      '/period/eligibleDates',
    ],
    [
      {
        ...period,
        eligibleDates: [
          '2026-04-01',
          '2026-04-02',
          '2026-04-03',
          '2026-04-04',
          '2026-04-06',
        ],
        activeDates: [
          '2026-04-01',
          '2026-04-02',
          '2026-04-03',
          '2026-04-04',
          '2026-04-06',
        ],
      },
      '/period/eligibleDates',
    ],
    [{ ...period, periodTarget: 6 }, '/period/periodTarget'],
    [
      {
        ...period,
        activeDates: ['2026-04-01', '2026-04-03', '2026-04-05'],
        eligibleDates: ['2026-04-01', '2026-04-03', '2026-04-05'],
      },
      '/period/activeDates',
    ],
  ] as const)('rejects malformed quota period %#', (candidate, pointer) => {
    expectInputIssue(
      () =>
        calculateExpectedPace({
          period: candidate as never,
          asOfLocalDate: '2026-04-01',
        }),
      pointer,
      'invalid_value',
    )
  })

  it('is deterministic for the same explicit calendar and as-of inputs', () => {
    jest.useFakeTimers()
    let firstCalendar: ReturnType<typeof calendar>
    let secondCalendar: ReturnType<typeof calendar>
    let secondSystemTimeCalendar: ReturnType<typeof calendar>
    let pace: number
    try {
      jest.setSystemTime(978_307_200_000)
      firstCalendar = calendar(
        { kind: 'weekly', n: '3' },
        { activeLocalDate: '2026-04-20' },
      )
      secondCalendar = calendar(
        { kind: 'weekly', n: '3' },
        { activeLocalDate: '2026-04-20' },
      )
      pace = calculateExpectedPace({
        period,
        asOfLocalDate: '2026-04-02',
      })
      jest.setSystemTime(4_102_444_799_999)
      secondSystemTimeCalendar = calendar(
        { kind: 'weekly', n: '3' },
        { activeLocalDate: '2026-04-20' },
      )
    } finally {
      jest.useRealTimers()
    }
    expect(firstCalendar).toEqual(secondCalendar)
    expect(firstCalendar).toEqual(secondSystemTimeCalendar)
    expect(pace).toBe(1)
  })
})
