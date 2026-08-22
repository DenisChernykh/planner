import {
  CALENDAR_TARGETS_FORMULA_VERSION,
  GoalEvaluationInputError,
  GOAL_EVALUATION_FORMULA_VERSION,
  SCORE_COVERAGE_FORMULA_VERSION,
  ScoreCoverageInputError,
  calculateScoreCoverage,
  evaluateGoalProgress,
  type GoalProgressResult,
} from '@/modules/progress'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'

import {
  PilotReportDependencyUnavailableError,
  PilotReportInputError,
  PilotReportSourceChangedError,
  PilotReportSourceInvalidError,
  PilotReportSourceNotFoundError,
} from './pilot-report.errors'
import type { PilotReportReadPort } from './pilot-report-read.port'
import {
  PILOT_REPORT_SCHEMA_VERSION,
  type CalculatePilotReportInput,
  type PilotReportFactTargetV1,
  type PilotReportGoalV1,
  type PilotReportSectionV1,
  type PilotReportSourceGoalV1,
  type PilotReportSourceV1,
  type PilotReportV1,
} from './pilot-report.types'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u

function canonicalLocalDate(value: string): boolean {
  const match = LOCAL_DATE_PATTERN.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function snapshotInput(
  input: CalculatePilotReportInput,
): CalculatePilotReportInput {
  if (
    input === null ||
    typeof input !== 'object' ||
    !UUID_PATTERN.test(input.spaceId) ||
    !UUID_PATTERN.test(input.publicationId) ||
    !canonicalLocalDate(input.asOfLocalDate)
  ) {
    throw new PilotReportInputError()
  }
  return Object.freeze({ ...input })
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    return Object.freeze(value)
  }
  return value
}

function fixedFactTarget(
  goal: PilotReportSourceGoalV1,
): PilotReportFactTargetV1 {
  const calendar = goal.progressInput.calendar.calendar
  if (calendar.kind !== 'fixed') throw new PilotReportSourceInvalidError()
  const dates = calendar.expectationDates.filter(
    (date) => date <= goal.progressInput.asOfLocalDate,
  )
  const snapshot = goal.progressInput.snapshot
  if (snapshot.checkpoints === null) {
    const facts = new Map(
      goal.progressInput.facts
        .filter((fact) => fact.kind === 'fixed')
        .map((fact) => [fact.expectationDate, fact.value] as const),
    )
    return {
      available: true,
      kind: 'fixed',
      units: dates.map((localDate) => ({
        localDate,
        componentId: null,
        fact: structuredClone(facts.get(localDate) ?? null),
        target: {
          measurement: structuredClone(snapshot.measurement),
          satisfaction: null,
        },
      })),
    }
  }
  const facts = new Map(
    goal.progressInput.facts
      .filter((fact) => fact.kind === 'fixed_checkpoints')
      .map(
        (fact) =>
          [
            fact.expectationDate,
            new Map(
              fact.checkpoints.map((checkpoint) => [
                checkpoint.checkpointId,
                checkpoint.value,
              ]),
            ),
          ] as const,
      ),
  )
  return {
    available: true,
    kind: 'fixed',
    units: dates.flatMap((localDate) =>
      snapshot.checkpoints!.items.map((checkpoint) => ({
        localDate,
        componentId: checkpoint.checkpointId,
        fact: structuredClone(
          facts.get(localDate)?.get(checkpoint.checkpointId) ?? null,
        ),
        target: {
          measurement: structuredClone(snapshot.measurement),
          satisfaction: structuredClone(checkpoint.satisfaction),
        },
      })),
    ),
  }
}

function weeklyTaskFactTarget(
  goal: PilotReportSourceGoalV1,
): PilotReportFactTargetV1 {
  const calendar = goal.progressInput.calendar.calendar
  if (calendar.kind !== 'weekly_planned_task') {
    throw new PilotReportSourceInvalidError()
  }
  const facts = new Map(
    goal.progressInput.facts
      .filter((fact) => fact.kind === 'weekly_planned_task')
      .map((fact) => [fact.periodStart, fact.result] as const),
  )
  return {
    available: true,
    kind: 'weekly_planned_task',
    periods: calendar.periods
      .filter(
        (period) => period.periodStart <= goal.progressInput.asOfLocalDate,
      )
      .map((period) => ({
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        fact: facts.get(period.periodStart) ?? 'no_data',
        target: 'done',
      })),
  }
}

function factTarget(
  goal: PilotReportSourceGoalV1,
  progress: GoalProgressResult,
): PilotReportFactTargetV1 {
  const measurement = goal.progressInput.snapshot.measurement
  if (measurement.kind === 'quantity' && measurement.mode === 'informational') {
    return {
      available: true,
      kind: 'informational_quantity',
      fact: structuredClone(goal.progressInput.facts),
      measurement: {
        kind: 'quantity',
        mode: 'informational',
        precision: measurement.precision,
        aggregation: measurement.aggregation,
        target: null,
      },
      target: null,
    }
  }
  if (!progress.progress.available) {
    return {
      available: false,
      kind: 'not_applicable',
      fact: null,
      target: null,
      reason: 'no_applicable_units',
    }
  }
  if (goal.progressInput.calendar.calendar.kind === 'fixed') {
    return fixedFactTarget(goal)
  }
  if (goal.progressInput.calendar.calendar.kind === 'weekly_planned_task') {
    return weeklyTaskFactTarget(goal)
  }
  return {
    available: true,
    kind: 'flexible',
    periods: progress.periods.map((period) => ({
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      fact: period.actualEquivalentOccurrences,
      target: period.periodTarget,
    })),
  }
}

function reportGoal(
  goal: PilotReportSourceGoalV1,
  progress: GoalProgressResult,
): PilotReportGoalV1 {
  return {
    planGoalSnapshotId: goal.planGoalSnapshotId,
    title: goal.title,
    displayOrder: goal.displayOrder,
    goalScore: progress.score,
    progressPercent: progress.progress,
    factTarget: factTarget(goal, progress),
    coverage: progress.coverage,
    overperformance: progress.overperformance,
  }
}

function section(
  kind: PilotReportSectionV1['kind'],
  ownerMemberId: string | null,
  goals: readonly {
    readonly source: PilotReportSourceGoalV1
    readonly progress: GoalProgressResult
  }[],
): PilotReportSectionV1 {
  const ordered = [...goals].sort(
    (left, right) =>
      left.source.displayOrder - right.source.displayOrder ||
      left.source.planGoalSnapshotId.localeCompare(
        right.source.planGoalSnapshotId,
      ),
  )
  const aggregate = calculateScoreCoverage({
    contributions: ordered.map((item) => item.progress.contribution),
  })
  return {
    kind,
    ownerMemberId,
    monthScore: aggregate.monthScore,
    coverage: aggregate.coverage,
    goals: ordered.map((item) => reportGoal(item.source, item.progress)),
  }
}

export function calculatePilotReport(
  input: CalculatePilotReportInput,
  source: PilotReportSourceV1,
): PilotReportV1 {
  if (
    source.spaceId !== input.spaceId ||
    source.publicationId !== input.publicationId ||
    source.memberIds.length !== 2 ||
    source.memberIds[0] === source.memberIds[1] ||
    source.formulaVersions.calendar !== CALENDAR_TARGETS_FORMULA_VERSION ||
    source.formulaVersions.evaluation !== GOAL_EVALUATION_FORMULA_VERSION ||
    source.formulaVersions.scoreCoverage !== SCORE_COVERAGE_FORMULA_VERSION ||
    source.goals.some(
      (goal) => goal.progressInput.asOfLocalDate !== input.asOfLocalDate,
    )
  ) {
    throw new PilotReportSourceInvalidError()
  }
  const members = new Set(source.memberIds)
  const personal = new Map<
    string,
    { source: PilotReportSourceGoalV1; progress: GoalProgressResult }[]
  >(source.memberIds.map((memberId) => [memberId, []]))
  const shared: {
    source: PilotReportSourceGoalV1
    progress: GoalProgressResult
  }[] = []
  for (const goal of source.goals) {
    const progress = evaluateGoalProgress(goal.progressInput)
    if (goal.scope.kind === 'shared') {
      shared.push({ source: goal, progress })
      continue
    }
    if (!members.has(goal.scope.ownerMemberId)) {
      throw new PilotReportSourceInvalidError()
    }
    personal.get(goal.scope.ownerMemberId)!.push({ source: goal, progress })
  }
  return freeze({
    schemaVersion: PILOT_REPORT_SCHEMA_VERSION,
    source: {
      spaceId: source.spaceId,
      planMonthId: source.planMonthId,
      publicationId: source.publicationId,
      publicationRevision: source.publicationRevision,
      factsRevision: source.factsRevision,
      asOfLocalDate: input.asOfLocalDate,
      formulaVersions: source.formulaVersions,
    },
    sections: [
      section(
        'personal',
        source.memberIds[0],
        personal.get(source.memberIds[0])!,
      ),
      section(
        'personal',
        source.memberIds[1],
        personal.get(source.memberIds[1])!,
      ),
      section('shared', null, shared),
    ],
  })
}

function accepted(error: unknown): boolean {
  return (
    error instanceof PilotReportInputError ||
    error instanceof PilotReportSourceNotFoundError ||
    error instanceof PilotReportSourceChangedError ||
    error instanceof PilotReportSourceInvalidError ||
    error instanceof PilotReportDependencyUnavailableError
  )
}

export class CalculatePilotReportUseCase {
  public constructor(
    private readonly reports: PilotReportReadPort,
    private readonly transaction: DatabaseTransactionPort,
  ) {}

  public async execute(
    input: CalculatePilotReportInput,
  ): Promise<PilotReportV1> {
    try {
      const snapshot = snapshotInput(input)
      const source = await this.transaction.run(
        () => this.reports.load(snapshot),
        { mode: 'repeatable_read_only' },
      )
      if (source === null) throw new PilotReportSourceNotFoundError()
      try {
        return calculatePilotReport(snapshot, source)
      } catch (error: unknown) {
        if (
          error instanceof GoalEvaluationInputError ||
          error instanceof ScoreCoverageInputError
        ) {
          throw new PilotReportSourceInvalidError({ cause: error })
        }
        throw error
      }
    } catch (error: unknown) {
      if (accepted(error)) throw error
      throw new PilotReportDependencyUnavailableError({ cause: error })
    }
  }
}
