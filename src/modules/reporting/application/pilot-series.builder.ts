import {
  isGoalFactSatisfied,
  type EvaluationCheckpointSatisfactionV1,
  type GoalEvaluationFactV1,
  type GoalFactValueV1,
} from '@/modules/progress'

import type {
  PilotReportGoalSeriesV1,
  PilotReportHeatmapPointV1,
  PilotReportReadGoalV1,
  PilotReportReadModelV1,
  PilotReportReadSectionV1,
  PilotReportSeriesPointV1,
  PilotReportSourceGoalV1,
  PilotReportSourceV1,
  PilotReportV1,
} from './pilot-report.types'

type SeriesFact = {
  readonly localDate: string
  readonly componentId: string | null
  readonly value: GoalFactValueV1
  readonly satisfaction: EvaluationCheckpointSatisfactionV1 | null
}

type HeatmapUnit = {
  readonly value: GoalFactValueV1 | undefined
  readonly satisfaction: EvaluationCheckpointSatisfactionV1 | null
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

function monthDates(targetMonth: string): readonly string[] {
  const year = Number(targetMonth.slice(0, 4))
  const month = Number(targetMonth.slice(5, 7))
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return Array.from(
    { length: days },
    (_, index) => `${targetMonth}-${String(index + 1).padStart(2, '0')}`,
  )
}

function fixedUnits(
  goal: PilotReportSourceGoalV1,
  localDate: string,
): readonly HeatmapUnit[] | null {
  const calendar = goal.progressInput.calendar.calendar
  if (
    calendar.kind !== 'fixed' ||
    !calendar.expectationDates.includes(localDate)
  ) {
    return null
  }
  const snapshot = goal.progressInput.snapshot
  const facts = goal.progressInput.facts
  if (snapshot.checkpoints === null) {
    const fact = facts.find(
      (item): item is Extract<GoalEvaluationFactV1, { kind: 'fixed' }> =>
        item.kind === 'fixed' && item.expectationDate === localDate,
    )
    return [
      {
        value: fact?.value,
        satisfaction: null,
      },
    ]
  }
  const fact = facts.find(
    (
      item,
    ): item is Extract<GoalEvaluationFactV1, { kind: 'fixed_checkpoints' }> =>
      item.kind === 'fixed_checkpoints' && item.expectationDate === localDate,
  )
  const values = new Map(
    fact?.checkpoints.map((item) => [item.checkpointId, item.value]) ?? [],
  )
  return snapshot.checkpoints.items.map((checkpoint) => ({
    value: values.get(checkpoint.checkpointId),
    satisfaction: checkpoint.satisfaction,
  }))
}

function quotaUnits(
  goal: PilotReportSourceGoalV1,
  localDate: string,
): readonly HeatmapUnit[] | null {
  const calendar = goal.progressInput.calendar.calendar
  if (calendar.kind !== 'quota') return null
  const applicable = calendar.periods.some((period) =>
    period.eligibleDates.includes(localDate),
  )
  if (!applicable) return null
  const values = goal.progressInput.facts
    .filter(
      (
        fact,
      ): fact is Extract<GoalEvaluationFactV1, { kind: 'quota_occurrence' }> =>
        fact.kind === 'quota_occurrence' && fact.localDate === localDate,
    )
    .map((fact) => ({ value: fact.value, satisfaction: null }))
  return values
}

function weeklyTaskUnits(
  goal: PilotReportSourceGoalV1,
  localDate: string,
): readonly HeatmapUnit[] | null {
  const calendar = goal.progressInput.calendar.calendar
  if (calendar.kind !== 'weekly_planned_task') return null
  const period = calendar.periods.find((item) => item.periodEnd === localDate)
  if (period === undefined) return null
  const fact = goal.progressInput.facts.find(
    (
      item,
    ): item is Extract<GoalEvaluationFactV1, { kind: 'weekly_planned_task' }> =>
      item.kind === 'weekly_planned_task' &&
      item.periodStart === period.periodStart,
  )
  return [
    {
      value:
        fact === undefined
          ? undefined
          : { kind: 'boolean', result: fact.result },
      satisfaction: null,
    },
  ]
}

function unitsAtDate(
  goal: PilotReportSourceGoalV1,
  localDate: string,
): readonly HeatmapUnit[] | null {
  if (localDate < goal.progressInput.calendarInput.activeLocalDate) return null
  const fixed = fixedUnits(goal, localDate)
  if (fixed !== null) return fixed
  const quota = quotaUnits(goal, localDate)
  if (quota !== null) return quota
  return weeklyTaskUnits(goal, localDate)
}

function heatmap(
  goal: PilotReportSourceGoalV1,
  asOfLocalDate: string,
): readonly PilotReportHeatmapPointV1[] {
  const dates = monthDates(goal.progressInput.calendarInput.targetMonth).filter(
    (date) => date <= asOfLocalDate,
  )
  return dates.map((localDate) => {
    const units = unitsAtDate(goal, localDate)
    if (units === null) return { localDate, state: 'not_applicable' as const }
    if (units.length === 0 || units.every((unit) => unit.value === undefined)) {
      return { localDate, state: 'no_data' as const }
    }
    const done = units.every((unit) =>
      isGoalFactSatisfied(
        goal.progressInput.snapshot.measurement,
        unit.value,
        unit.satisfaction,
      ),
    )
    return {
      localDate,
      state: done ? ('done' as const) : ('not_done' as const),
    }
  })
}

function seriesFacts(goal: PilotReportSourceGoalV1): readonly SeriesFact[] {
  const snapshot = goal.progressInput.snapshot
  const facts = goal.progressInput.facts
  const result: SeriesFact[] = []
  for (const fact of facts) {
    if (fact.kind === 'fixed') {
      result.push({
        localDate: fact.expectationDate,
        componentId: null,
        value: fact.value,
        satisfaction: null,
      })
      continue
    }
    if (fact.kind === 'fixed_checkpoints') {
      for (const checkpoint of fact.checkpoints) {
        const satisfaction =
          snapshot.checkpoints?.items.find(
            (item) => item.checkpointId === checkpoint.checkpointId,
          )?.satisfaction ?? null
        result.push({
          localDate: fact.expectationDate,
          componentId: checkpoint.checkpointId,
          value: checkpoint.value,
          satisfaction,
        })
      }
      continue
    }
    if (fact.kind === 'quota_occurrence') {
      result.push({
        localDate: fact.localDate,
        componentId: null,
        value: fact.value,
        satisfaction: null,
      })
    }
  }
  return result.sort(
    (left, right) =>
      left.localDate.localeCompare(right.localDate) ||
      (left.componentId ?? '').localeCompare(right.componentId ?? ''),
  )
}

function decimalToScaled(value: string, precision: number): bigint {
  const [whole = '0', fraction = ''] = value.split('.')
  const normalized = fraction.padEnd(precision, '0').slice(0, precision)
  return BigInt(whole) * 10n ** BigInt(precision) + BigInt(normalized || '0')
}

function scaledToDecimal(value: bigint, precision: number): string {
  if (precision === 0) return value.toString(10)
  const scale = 10n ** BigInt(precision)
  const whole = value / scale
  const fraction = value % scale
  const rendered = fraction
    .toString(10)
    .padStart(precision, '0')
    .replace(/0+$/u, '')
  return rendered.length === 0 ? whole.toString(10) : `${whole}.${rendered}`
}

function quantitySeries(
  goal: PilotReportSourceGoalV1,
  facts: readonly SeriesFact[],
): readonly PilotReportSeriesPointV1[] | null {
  const measurement = goal.progressInput.snapshot.measurement
  if (measurement.kind !== 'quantity') return null
  const values = facts.flatMap((item) => {
    if (item.value.kind === 'quantity_add') {
      return [
        {
          ...item,
          scaled: item.value.contributions.reduce(
            (sum, contribution) =>
              sum + decimalToScaled(contribution.value, measurement.precision),
            0n,
          ),
        },
      ]
    }
    if (item.value.kind === 'quantity_latest') {
      return [
        {
          ...item,
          scaled: decimalToScaled(item.value.value, measurement.precision),
        },
      ]
    }
    return []
  })
  const cumulativeByComponent = new Map<string | null, bigint>()
  return values.map((item) => {
    const cumulative =
      (cumulativeByComponent.get(item.componentId) ?? 0n) + item.scaled
    cumulativeByComponent.set(item.componentId, cumulative)
    return {
      localDate: item.localDate,
      componentId: item.componentId,
      value: scaledToDecimal(cumulative, measurement.precision),
    }
  })
}

function valueSeries(
  facts: readonly SeriesFact[],
  kind: 'actual_time' | 'rating',
  supportsKind: boolean,
): readonly PilotReportSeriesPointV1[] | null {
  if (!supportsKind) return null
  const points: PilotReportSeriesPointV1[] = []
  for (const item of facts) {
    if (kind === 'actual_time' && item.value.kind === 'actual_time') {
      points.push({
        localDate: item.localDate,
        componentId: item.componentId,
        value: item.value.value,
      })
      continue
    }
    if (kind === 'rating' && item.value.kind === 'rating') {
      points.push({
        localDate: item.localDate,
        componentId: item.componentId,
        value: item.value.value,
      })
    }
  }
  return points
}

function goalSeries(
  goal: PilotReportSourceGoalV1,
  asOfLocalDate: string,
): PilotReportGoalSeriesV1 {
  const facts = seriesFacts(goal).filter(
    (item) => item.localDate <= asOfLocalDate,
  )
  const measurement = goal.progressInput.snapshot.measurement
  const checkpoints = goal.progressInput.snapshot.checkpoints?.items ?? []
  return {
    heatmap: heatmap(goal, asOfLocalDate),
    cumulativeQuantity: quantitySeries(goal, facts),
    actualTime: valueSeries(
      facts,
      'actual_time',
      measurement.kind === 'actual_time' ||
        checkpoints.some((item) => item.satisfaction.kind === 'actual_time'),
    ),
    rating: valueSeries(
      facts,
      'rating',
      measurement.kind === 'rating' ||
        checkpoints.some((item) => item.satisfaction.kind === 'rating'),
    ),
  }
}

export function buildPilotReportSeries(
  source: PilotReportSourceV1,
  report: PilotReportV1,
  asOfLocalDate: string,
): PilotReportReadModelV1['sections'] {
  const sourceGoals = new Map(
    source.goals.map((goal) => [goal.planGoalSnapshotId, goal] as const),
  )
  const sections = report.sections.map((section) => {
    const goals: readonly PilotReportReadGoalV1[] = section.goals.map(
      (goal) => {
        const sourceGoal = sourceGoals.get(goal.planGoalSnapshotId)
        if (sourceGoal === undefined)
          throw new Error('Report goal source missing')
        return {
          ...goal,
          series: goalSeries(sourceGoal, asOfLocalDate),
        }
      },
    )
    return {
      ...section,
      goals,
    } satisfies PilotReportReadSectionV1
  })
  return freeze(sections) as unknown as PilotReportReadModelV1['sections']
}
