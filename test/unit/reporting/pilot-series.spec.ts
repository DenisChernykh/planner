import {
  buildPilotReportSeries,
  calculatePilotReport,
  type PilotReportSourceGoalV1,
  type PilotReportSourceV1,
} from '@/modules/reporting'
import {
  CALENDAR_TARGETS_FORMULA_VERSION,
  GOAL_EVALUATION_FORMULA_VERSION,
  SCORE_COVERAGE_FORMULA_VERSION,
  calculateEligibleCalendar,
  type EvaluateGoalProgressInput,
  type EvaluationMeasurementV1,
  type GoalEvaluationFactV1,
} from '@/modules/progress'

const spaceId = '33333333-3333-4333-8333-333333333333'
const publicationId = '77777777-7777-4777-8777-777777777777'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'

function progressInput(
  measurement: EvaluationMeasurementV1,
  facts: readonly GoalEvaluationFactV1[],
): EvaluateGoalProgressInput {
  const calendarInput = {
    targetMonth: '2026-04',
    activeLocalDate: '2026-04-01',
    timeZone: 'Asia/Yekaterinburg' as const,
    repetition: { kind: 'daily' as const },
  }
  const calendar = calculateEligibleCalendar(calendarInput)
  if (!calendar.eligible) throw new Error('expected eligible calendar')
  return {
    snapshot: {
      schemaVersion: 'planner.goal-evaluation-snapshot.v1',
      measurement,
      checkpoints: null,
    },
    calendarInput,
    calendar,
    facts,
    asOfLocalDate: '2026-04-03',
  }
}

function goal(
  index: number,
  title: string,
  measurement: EvaluationMeasurementV1,
  facts: readonly GoalEvaluationFactV1[],
): PilotReportSourceGoalV1 {
  return {
    planGoalSnapshotId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
    title,
    displayOrder: index,
    scope: { kind: 'personal', ownerMemberId: firstMemberId },
    progressInput: progressInput(measurement, facts),
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

describe('R02 pilot report series builder', () => {
  it('builds deterministic heatmap and typed series without completed-v1 analytics', () => {
    const reportSource = source([
      goal(1, 'Boolean', { kind: 'boolean' }, [
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
      goal(
        2,
        'Quantity',
        {
          kind: 'quantity',
          mode: 'targeted',
          precision: 1,
          aggregation: 'latest',
          target: '10.0',
        },
        [
          {
            kind: 'fixed',
            expectationDate: '2026-04-01',
            value: { kind: 'quantity_latest', value: '2.5' },
          },
          {
            kind: 'fixed',
            expectationDate: '2026-04-02',
            value: { kind: 'quantity_latest', value: '3.5' },
          },
        ],
      ),
      goal(3, 'Time', { kind: 'actual_time', start: '09:00', end: '18:00' }, [
        {
          kind: 'fixed',
          expectationDate: '2026-04-01',
          value: { kind: 'actual_time', value: '10:30' },
        },
      ]),
      goal(4, 'Rating', { kind: 'rating', minimum: 1, maximum: 10 }, [
        {
          kind: 'fixed',
          expectationDate: '2026-04-01',
          value: { kind: 'rating', value: 8 },
        },
      ]),
    ])
    const report = calculatePilotReport(
      { spaceId, publicationId, asOfLocalDate: '2026-04-03' },
      reportSource,
    )
    const sections = buildPilotReportSeries(reportSource, report, '2026-04-03')
    const goals = sections[0].goals

    expect(goals[0]?.series.heatmap.slice(-3)).toEqual([
      { localDate: '2026-04-01', state: 'done' },
      { localDate: '2026-04-02', state: 'not_done' },
      { localDate: '2026-04-03', state: 'no_data' },
    ])
    expect(goals[1]?.series.cumulativeQuantity).toEqual([
      { localDate: '2026-04-01', componentId: null, value: '2.5' },
      { localDate: '2026-04-02', componentId: null, value: '6' },
    ])
    expect(goals[2]?.series.actualTime).toEqual([
      { localDate: '2026-04-01', componentId: null, value: '10:30' },
    ])
    expect(goals[3]?.series.rating).toEqual([
      { localDate: '2026-04-01', componentId: null, value: 8 },
    ])
    expect(goals[0]?.series.cumulativeQuantity).toBeNull()
    expect(goals[1]?.series.actualTime).toBeNull()
    expect(goals[2]?.series.rating).toBeNull()
    expect(Object.isFrozen(sections)).toBe(true)
    expect(JSON.stringify(sections)).not.toMatch(
      /forecast|correlation|streak/iu,
    )
  })

  it('keeps cumulative quantity independent for checkpoint components', () => {
    const measurement = {
      kind: 'quantity' as const,
      mode: 'targeted' as const,
      precision: 0 as const,
      aggregation: 'add' as const,
      target: '100',
    }
    const base = progressInput(measurement, [])
    const checkpointGoal: PilotReportSourceGoalV1 = {
      ...goal(5, 'Checkpoint quantity', measurement, []),
      progressInput: {
        ...base,
        snapshot: {
          ...base.snapshot,
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                satisfaction: { kind: 'quantity', target: '100' },
              },
              {
                checkpointId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                satisfaction: { kind: 'quantity', target: '100' },
              },
            ],
          },
        },
        facts: [
          {
            kind: 'fixed_checkpoints',
            expectationDate: '2026-04-01',
            checkpoints: [
              {
                checkpointId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                value: {
                  kind: 'quantity_add',
                  contributions: [{ contributionId: 'a1', value: '10' }],
                },
              },
              {
                checkpointId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                value: {
                  kind: 'quantity_add',
                  contributions: [{ contributionId: 'b1', value: '20' }],
                },
              },
            ],
          },
          {
            kind: 'fixed_checkpoints',
            expectationDate: '2026-04-02',
            checkpoints: [
              {
                checkpointId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                value: {
                  kind: 'quantity_add',
                  contributions: [{ contributionId: 'a2', value: '5' }],
                },
              },
              {
                checkpointId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                value: {
                  kind: 'quantity_add',
                  contributions: [{ contributionId: 'b2', value: '7' }],
                },
              },
            ],
          },
        ],
      },
    }
    const reportSource = source([checkpointGoal])
    const report = calculatePilotReport(
      { spaceId, publicationId, asOfLocalDate: '2026-04-03' },
      reportSource,
    )
    const sections = buildPilotReportSeries(reportSource, report, '2026-04-03')

    expect(sections[0]?.goals[0]?.series.cumulativeQuantity).toEqual([
      {
        localDate: '2026-04-01',
        componentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        value: '10',
      },
      {
        localDate: '2026-04-01',
        componentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        value: '20',
      },
      {
        localDate: '2026-04-02',
        componentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        value: '15',
      },
      {
        localDate: '2026-04-02',
        componentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        value: '27',
      },
    ])
  })
})
