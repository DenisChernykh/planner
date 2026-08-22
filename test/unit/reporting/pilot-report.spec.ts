import {
  calculatePilotReport,
  CalculatePilotReportUseCase,
  PilotReportInputError,
  PilotReportSourceInvalidError,
  type PilotReportReadPort,
  type PilotReportSourceGoalV1,
  type PilotReportSourceV1,
} from '@/modules/reporting'
import {
  CALENDAR_TARGETS_FORMULA_VERSION,
  GOAL_EVALUATION_FORMULA_VERSION,
  SCORE_COVERAGE_FORMULA_VERSION,
  calculateEligibleCalendar,
  type EvaluateGoalProgressInput,
  type GoalEvaluationFactV1,
  type GoalEvaluationSnapshotV1,
} from '@/modules/progress'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'

const spaceId = '33333333-3333-4333-8333-333333333333'
const publicationId = '77777777-7777-4777-8777-777777777777'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'

const transaction: DatabaseTransactionPort = {
  run: (operation) => operation(),
}

function progressInput(input: {
  readonly measurement: GoalEvaluationSnapshotV1['measurement']
  readonly facts?: readonly GoalEvaluationFactV1[]
  readonly dueDate?: string
  readonly asOfLocalDate?: string
}): EvaluateGoalProgressInput {
  const dueDate = input.dueDate ?? '2026-04-10'
  const calendarInput = {
    targetMonth: '2026-04',
    activeLocalDate: '2026-04-01',
    timeZone: 'Asia/Yekaterinburg' as const,
    repetition: { kind: 'one_off' as const, dueDate },
  }
  const calendar = calculateEligibleCalendar(calendarInput)
  if (!calendar.eligible) throw new Error('expected eligible calendar')
  return {
    snapshot: {
      schemaVersion: 'planner.goal-evaluation-snapshot.v1',
      measurement: input.measurement,
      checkpoints: null,
    },
    calendarInput,
    calendar,
    facts: input.facts ?? [],
    asOfLocalDate: input.asOfLocalDate ?? dueDate,
  }
}

function targetedGoal(
  index: number,
  ownerMemberId: string,
  value: string | null,
): PilotReportSourceGoalV1 {
  const goalId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`
  return {
    planGoalSnapshotId: goalId,
    title: `Goal ${index}`,
    displayOrder: index,
    scope: { kind: 'personal', ownerMemberId },
    progressInput: progressInput({
      measurement: {
        kind: 'quantity',
        mode: 'targeted',
        precision: 0,
        aggregation: 'latest',
        target: '100',
      },
      facts:
        value === null
          ? []
          : [
              {
                kind: 'fixed',
                expectationDate: '2026-04-10',
                value: { kind: 'quantity_latest', value },
              },
            ],
    }),
  }
}

function source(
  goals: readonly PilotReportSourceGoalV1[],
): PilotReportSourceV1 {
  return {
    spaceId,
    planMonthId: '66666666-6666-4666-8666-666666666666',
    publicationId,
    publicationRevision: 1n,
    factsRevision: 5n,
    formulaVersions: {
      calendar: CALENDAR_TARGETS_FORMULA_VERSION,
      evaluation: GOAL_EVALUATION_FORMULA_VERSION,
      scoreCoverage: SCORE_COVERAGE_FORMULA_VERSION,
    },
    memberIds: [firstMemberId, secondMemberId],
    goals,
  }
}

function useCase(value: PilotReportSourceV1): CalculatePilotReportUseCase {
  const reports: PilotReportReadPort = {
    load: () => Promise.resolve(value),
  }
  return new CalculatePilotReportUseCase(reports, transaction)
}

function input(): {
  readonly spaceId: string
  readonly publicationId: string
  readonly asOfLocalDate: string
} {
  return { spaceId, publicationId, asOfLocalDate: '2026-04-10' }
}

describe('R01 pilot provisional report', () => {
  it('separates personal/shared goals and keeps 100/50/130 exact until the section aggregate', async () => {
    const shared: PilotReportSourceGoalV1 = {
      planGoalSnapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000004',
      title: 'Shared',
      displayOrder: 4,
      scope: { kind: 'shared' },
      progressInput: progressInput({
        measurement: { kind: 'boolean' },
        facts: [
          {
            kind: 'fixed',
            expectationDate: '2026-04-10',
            value: { kind: 'boolean', result: 'done' },
          },
        ],
      }),
    }
    const report = await useCase(
      source([
        targetedGoal(3, firstMemberId, '130'),
        targetedGoal(1, firstMemberId, '100'),
        targetedGoal(2, firstMemberId, '50'),
        targetedGoal(5, secondMemberId, '100'),
        shared,
      ]),
    ).execute(input())

    expect(report.source).toMatchObject({
      publicationId,
      factsRevision: 5n,
      asOfLocalDate: '2026-04-10',
    })
    expect(report.sections.map((section) => section.ownerMemberId)).toEqual([
      firstMemberId,
      secondMemberId,
      null,
    ])
    const first = report.sections[0]
    expect(first.goals.map((goal) => goal.displayOrder)).toEqual([1, 2, 3])
    expect(first.monthScore).toMatchObject({
      available: true,
      exact: { numerator: '5', denominator: '6' },
      basisPoints: '8333',
    })
    expect(first.goals[2]).toMatchObject({
      progressPercent: { basisPoints: '13000' },
      goalScore: { basisPoints: '10000' },
      factTarget: {
        kind: 'fixed',
        units: [
          {
            localDate: '2026-04-10',
            componentId: null,
            fact: { kind: 'quantity_latest', value: '130' },
            target: {
              measurement: { kind: 'quantity', target: '100' },
              satisfaction: null,
            },
          },
        ],
      },
      overperformance: { basisPoints: '3000' },
    })
    expect(report.sections[1].goals).toHaveLength(1)
    expect(report.sections[2].goals).toHaveLength(1)
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.sections)).toBe(true)
    expect(Object.isFrozen(first.goals[0])).toBe(true)
  })

  it('preserves no-data, not-applicable and informational quantity semantics', async () => {
    const noData = targetedGoal(1, firstMemberId, null)
    const notApplicable: PilotReportSourceGoalV1 = {
      ...targetedGoal(2, firstMemberId, null),
      progressInput: progressInput({
        measurement: {
          kind: 'quantity',
          mode: 'targeted',
          precision: 0,
          aggregation: 'latest',
          target: '100',
        },
        dueDate: '2026-04-20',
        asOfLocalDate: '2026-04-10',
      }),
    }
    const informational: PilotReportSourceGoalV1 = {
      planGoalSnapshotId: 'cccccccc-cccc-4ccc-8ccc-000000000003',
      title: 'Informational',
      displayOrder: 3,
      scope: { kind: 'personal', ownerMemberId: firstMemberId },
      progressInput: progressInput({
        measurement: {
          kind: 'quantity',
          mode: 'informational',
          precision: 0,
          aggregation: 'add',
          target: null,
        },
        facts: [
          {
            kind: 'fixed',
            expectationDate: '2026-04-10',
            value: {
              kind: 'quantity_add',
              contributions: [
                { contributionId: 'z', value: '2' },
                { contributionId: 'a', value: '40' },
              ],
            },
          },
        ],
      }),
    }

    const first = (
      await useCase(source([informational, notApplicable, noData])).execute(
        input(),
      )
    ).sections[0]
    expect(first.goals[0]).toMatchObject({
      progressPercent: { available: true, basisPoints: '0' },
      goalScore: { available: true, basisPoints: '0' },
      coverage: { filled: '0', applicable: '1' },
    })
    expect(first.goals[1]).toMatchObject({
      progressPercent: {
        available: false,
        reason: 'no_applicable_units',
      },
      factTarget: {
        available: false,
        reason: 'no_applicable_units',
      },
    })
    expect(first.goals[2]).toMatchObject({
      progressPercent: { available: false, reason: 'informational' },
      goalScore: { available: false, reason: 'informational' },
      factTarget: {
        available: true,
        kind: 'informational_quantity',
        fact: [
          {
            kind: 'fixed',
            expectationDate: '2026-04-10',
            value: {
              kind: 'quantity_add',
              contributions: [
                { contributionId: 'z', value: '2' },
                { contributionId: 'a', value: '40' },
              ],
            },
          },
        ],
        measurement: {
          kind: 'quantity',
          mode: 'informational',
          aggregation: 'add',
          target: null,
        },
        target: null,
      },
    })
    expect(first.monthScore).toMatchObject({
      available: true,
      basisPoints: '0',
    })
  })

  it('returns N/A aggregates for empty sections and is deterministic', async () => {
    const calculate = useCase(source([]))
    const first = await calculate.execute(input())
    const second = await calculate.execute(input())
    expect(first).toEqual(second)
    expect(calculatePilotReport(input(), source([]))).toEqual(first)
    for (const section of first.sections) {
      expect(section.monthScore).toEqual({
        available: false,
        exact: null,
        basisPoints: null,
        reason: 'no_scored_goals',
      })
      expect(section.coverage).toEqual({
        available: false,
        exact: null,
        basisPoints: null,
        reason: 'no_fixed_units',
      })
    }
  })

  it('rejects malformed input and ownership outside the exact pair', async () => {
    await expect(
      useCase(source([])).execute({ ...input(), asOfLocalDate: '2026-02-30' }),
    ).rejects.toBeInstanceOf(PilotReportInputError)
    await expect(
      useCase(
        source([
          targetedGoal(1, '99999999-9999-4999-8999-999999999999', '100'),
        ]),
      ).execute(input()),
    ).rejects.toBeInstanceOf(PilotReportSourceInvalidError)
    await expect(
      useCase(
        source([
          {
            ...targetedGoal(1, firstMemberId, '100'),
            progressInput: progressInput({
              measurement: {
                kind: 'quantity',
                mode: 'targeted',
                precision: 0,
                aggregation: 'latest',
                target: '100',
              },
              asOfLocalDate: '2026-04-09',
            }),
          },
        ]),
      ).execute(input()),
    ).rejects.toBeInstanceOf(PilotReportSourceInvalidError)
  })
})
