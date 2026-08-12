import {
  SCORE_COVERAGE_FORMULA_VERSION,
  ScoreCoverageInputError,
  calculateScoreCoverage,
  type ScoreCoverageContributionV1,
} from '@/modules/progress'

function contribution(
  numerator: string | null,
  denominator = '1',
  filled = '0',
  applicable = '0',
): ScoreCoverageContributionV1 {
  return {
    score:
      numerator === null
        ? null
        : {
            numerator,
            denominator,
          },
    coverage: { filled, applicable },
  }
}

function expectInputIssue(
  action: () => unknown,
  pointer: string,
  code: string,
): void {
  try {
    action()
    throw new Error('expected ScoreCoverageInputError')
  } catch (error) {
    expect(error).toBeInstanceOf(ScoreCoverageInputError)
    expect((error as ScoreCoverageInputError).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ pointer, code })]),
    )
  }
}

function overLimitContributions(): {
  readonly value: readonly ScoreCoverageContributionV1[]
  readonly boundaryReads: () => number
} {
  const target: ScoreCoverageContributionV1[] = []
  target.length = 10_001
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

describe('P05 exact section score and coverage', () => {
  it('caps goal contributions before the equal-weight 100/50/130 aggregate', () => {
    const result = calculateScoreCoverage({
      contributions: [
        contribution('1'),
        contribution('1', '2'),
        contribution('1'),
      ],
    })

    expect(result).toEqual({
      formulaVersion: SCORE_COVERAGE_FORMULA_VERSION,
      monthScore: {
        available: true,
        exact: { numerator: '5', denominator: '6' },
        basisPoints: '8333',
      },
      coverage: {
        available: false,
        exact: null,
        basisPoints: null,
        reason: 'no_fixed_units',
      },
      totals: { scoredGoals: '3', filled: '0', applicable: '0' },
    })
  })

  it('sums coverage counts instead of averaging goal percentages', () => {
    const result = calculateScoreCoverage({
      contributions: [
        contribution(null, '1', '1', '1'),
        contribution(null, '1', '0', '9'),
      ],
    })

    expect(result.coverage).toEqual({
      available: true,
      exact: { numerator: '1', denominator: '10' },
      basisPoints: '1000',
    })
    expect(result.totals).toEqual({
      scoredGoals: '0',
      filled: '1',
      applicable: '10',
    })
  })

  it('keeps 1/2 and 1/6 exact until the parent mean', () => {
    const result = calculateScoreCoverage({
      contributions: [contribution('1', '2'), contribution('1', '6')],
    })
    expect(result.monthScore).toEqual({
      available: true,
      exact: { numerator: '1', denominator: '3' },
      basisPoints: '3333',
    })
  })

  it('fully reduces exact ratios beyond the safe-integer fast path', () => {
    const result = calculateScoreCoverage({
      contributions: [contribution('10000000000000002', '20000000000000004')],
    })
    expect(result.monthScore).toEqual({
      available: true,
      exact: { numerator: '1', denominator: '2' },
      basisPoints: '5000',
    })
  })

  it('rounds half up only at the basis-point boundary', () => {
    expect(
      calculateScoreCoverage({ contributions: [contribution('1', '20000')] })
        .monthScore,
    ).toEqual({
      available: true,
      exact: { numerator: '1', denominator: '20000' },
      basisPoints: '1',
    })
    expect(
      calculateScoreCoverage({ contributions: [contribution('1', '20001')] })
        .monthScore,
    ).toEqual({
      available: true,
      exact: { numerator: '1', denominator: '20001' },
      basisPoints: '0',
    })
  })

  it('excludes unavailable scores and returns finite empty reasons', () => {
    const empty = calculateScoreCoverage({ contributions: [] })
    expect(empty.monthScore).toEqual({
      available: false,
      exact: null,
      basisPoints: null,
      reason: 'no_scored_goals',
    })
    expect(empty.coverage).toEqual({
      available: false,
      exact: null,
      basisPoints: null,
      reason: 'no_fixed_units',
    })

    const informational = calculateScoreCoverage({
      contributions: [contribution(null, '1', '1', '1')],
    })
    expect(informational.monthScore).toEqual(empty.monthScore)
    expect(informational.coverage.available).toBe(true)
  })

  it('handles huge exact ratios without converting caller strings to Number', () => {
    const huge = '9'.repeat(100_000)
    const result = calculateScoreCoverage({
      contributions: [contribution(huge, huge)],
    })
    expect(result.monthScore).toEqual({
      available: true,
      exact: { numerator: '1', denominator: '1' },
      basisPoints: '10000',
    })
  })

  it('charges raw equal-ratio digits before normalization', () => {
    const overBudget = '9'.repeat(125_001)
    expectInputIssue(
      () =>
        calculateScoreCoverage({
          contributions: [contribution(overBudget, overBudget)],
        }),
      '/contributions',
      'input_too_complex',
    )
  })

  it('charges all raw digits before reducing any earlier ratio', () => {
    const expensive = '9'.repeat(5_001)
    const overBudget = '9'.repeat(125_001)
    expectInputIssue(
      () =>
        calculateScoreCoverage({
          contributions: [
            contribution(expensive, `${expensive}1`),
            contribution(overBudget, overBudget),
          ],
        }),
      '/contributions',
      'input_too_complex',
    )
  })

  it('aggregates distinct huge denominators with bounded string arithmetic', () => {
    const zeros = '0'.repeat(1_000)
    const result = calculateScoreCoverage({
      contributions: [
        contribution('1', `1${zeros}`),
        contribution('1', `2${zeros}`),
      ],
    })

    expect(result.monthScore).toEqual({
      available: true,
      exact: { numerator: '3', denominator: `4${zeros}` },
      basisPoints: '0',
    })
  })

  it('rejects projected exact work over the deterministic public budget', () => {
    const zeros = '0'.repeat(50_000)
    expectInputIssue(
      () =>
        calculateScoreCoverage({
          contributions: [
            contribution('1', `1${zeros}`),
            contribution('1', `2${zeros}`),
          ],
        }),
      '/contributions',
      'input_too_complex',
    )
  })

  it('rejects too many aggregate terms before reading contribution rows', () => {
    let reads = 0
    const row = contribution('1') as unknown as Record<string, unknown>
    Object.defineProperty(row, 'score', {
      enumerable: true,
      get() {
        reads += 1
        return { numerator: '1', denominator: '1' }
      },
    })

    expectInputIssue(
      () =>
        calculateScoreCoverage({
          contributions: Array.from({ length: 10_001 }, (_, index) =>
            index === 0 ? row : contribution('1'),
          ) as readonly ScoreCoverageContributionV1[],
        }),
      '/contributions',
      'input_too_complex',
    )
    expect(reads).toBe(0)
  })

  it('rejects an over-limit aggregate array before reflecting its keys or descriptors', () => {
    const oversized = overLimitContributions()
    expectInputIssue(
      () =>
        calculateScoreCoverage({
          contributions: oversized.value,
        }),
      '/contributions',
      'input_too_complex',
    )
    expect(oversized.boundaryReads()).toBe(0)
  })

  it('returns a detached recursively frozen aggregate', () => {
    const mutable: ScoreCoverageContributionV1[] = [
      contribution('1', '2', '1', '2'),
    ]
    const result = calculateScoreCoverage({ contributions: mutable })
    mutable.length = 0

    expect(result.monthScore.available).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.monthScore)).toBe(true)
    expect(Object.isFrozen(result.monthScore.exact)).toBe(true)
    expect(Object.isFrozen(result.coverage)).toBe(true)
    expect(Object.isFrozen(result.totals)).toBe(true)
  })
})

describe('P05 aggregate exact input boundary', () => {
  it('rejects nested score and coverage mutations without invoking accessors', () => {
    expectInputIssue(
      () =>
        calculateScoreCoverage({
          contributions: [
            {
              score: { numerator: '1', denominator: '2', extra: true },
              coverage: { filled: '0', applicable: '0' },
            } as never,
          ],
        }),
      '/contributions/0/score',
      'unexpected_property',
    )

    const symbolCoverage = { filled: '0', applicable: '0' }
    Object.defineProperty(symbolCoverage, Symbol('extra'), { value: true })
    expectInputIssue(
      () =>
        calculateScoreCoverage({
          contributions: [{ score: null, coverage: symbolCoverage }],
        }),
      '/contributions/0/coverage',
      'unexpected_property',
    )

    const nullPrototypeScore: unknown = Object.assign(Object.create(null), {
      numerator: '1',
      denominator: '2',
    })
    expectInputIssue(
      () =>
        calculateScoreCoverage({
          contributions: [
            {
              score: nullPrototypeScore,
              coverage: { filled: '0', applicable: '0' },
            } as unknown as ScoreCoverageContributionV1,
          ],
        }),
      '/contributions/0/score',
      'invalid_type',
    )

    let scoreGetterReads = 0
    const scoreAccessor: Record<string, unknown> = { denominator: '2' }
    Object.defineProperty(scoreAccessor, 'numerator', {
      enumerable: true,
      get() {
        scoreGetterReads += 1
        return '1'
      },
    })
    expectInputIssue(
      () =>
        calculateScoreCoverage({
          contributions: [
            {
              score: scoreAccessor,
              coverage: { filled: '0', applicable: '0' },
            } as never,
          ],
        }),
      '/contributions/0/score',
      'invalid_type',
    )
    expect(scoreGetterReads).toBe(0)

    let coverageGetterReads = 0
    const coverageAccessor: Record<string, unknown> = { applicable: '1' }
    Object.defineProperty(coverageAccessor, 'filled', {
      enumerable: true,
      get() {
        coverageGetterReads += 1
        return '1'
      },
    })
    expectInputIssue(
      () =>
        calculateScoreCoverage({
          contributions: [{ score: null, coverage: coverageAccessor } as never],
        }),
      '/contributions/0/coverage',
      'invalid_type',
    )
    expect(coverageGetterReads).toBe(0)
  })

  it('rejects extra fields, non-plain objects, accessors and sparse arrays', () => {
    expectInputIssue(
      () => calculateScoreCoverage({ contributions: [], extra: true } as never),
      '',
      'unexpected_property',
    )
    expectInputIssue(
      () =>
        calculateScoreCoverage(
          Object.assign(Object.create(null), { contributions: [] }) as never,
        ),
      '',
      'invalid_type',
    )

    let reads = 0
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, 'contributions', {
      enumerable: true,
      get() {
        reads += 1
        return []
      },
    })
    expectInputIssue(
      () => calculateScoreCoverage(accessor as never),
      '',
      'invalid_type',
    )
    expect(reads).toBe(0)

    const sparse = new Array<ScoreCoverageContributionV1>(1)
    expectInputIssue(
      () => calculateScoreCoverage({ contributions: sparse }),
      '/contributions',
      'invalid_type',
    )
  })

  it.each([
    [contribution('01'), '/contributions/0/score', 'invalid_value'],
    [contribution('1', '0'), '/contributions/0/score', 'invalid_value'],
    [contribution('2', '1'), '/contributions/0/score', 'incompatible'],
    [
      contribution(null, '1', '2', '1'),
      '/contributions/0/coverage',
      'incompatible',
    ],
    [
      contribution(null, '1', '-1', '1'),
      '/contributions/0/coverage',
      'invalid_value',
    ],
  ] as const)(
    'rejects malformed exact contribution %#',
    (candidate, pointer, code) => {
      expectInputIssue(
        () => calculateScoreCoverage({ contributions: [candidate] }),
        pointer,
        code,
      )
    },
  )

  it('freezes finite errors and does not leak rejected values', () => {
    const rejected = 'secret-score-value'
    try {
      calculateScoreCoverage({
        contributions: [contribution(rejected)],
      })
      throw new Error('expected ScoreCoverageInputError')
    } catch (error) {
      expect(error).toBeInstanceOf(ScoreCoverageInputError)
      if (error instanceof ScoreCoverageInputError) {
        expect(Object.isFrozen(error)).toBe(true)
        expect(Object.isFrozen(error.issues)).toBe(true)
        expect(Object.isFrozen(error.issues[0])).toBe(true)
        expect(JSON.stringify(error.issues)).not.toContain(rejected)
      }
    }
  })
})
