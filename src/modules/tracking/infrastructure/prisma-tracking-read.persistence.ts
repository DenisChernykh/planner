import type { GoalConfigV1 } from '@/modules/planning/domain/goal-config'
import { snapshotStoredDraftGoalConfig } from '@/modules/planning/domain/goal-config'
import { validateGoalConfig } from '@/modules/planning/domain/goal-validation'
import type { PublicationCalendar } from '@/modules/planning/domain/publication'
import {
  calculateExpectedPace,
  evaluateGoalProgress,
  type GoalEvaluationFactV1,
  type GoalFactValueV1,
  type GoalProgressResult,
} from '@/modules/progress'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  GetTrackingReadPersistenceInput,
  TrackingReadPersistencePort,
} from '../application/tracking-read-persistence.port'
import type {
  TrackingDayGoalV1,
  TrackingDayReadV1,
  TrackingDayStateV1,
  TrackingExpectationStateV1,
  TrackingFactReadV1,
  TrackingFixedExpectationV1,
  TrackingFlexiblePeriodV1,
  TrackingGoalReadV1,
  TrackingMonthPhaseV1,
  TrackingMonthStateV1,
  TrackingPublishedReadV1,
  TrackingViewerAccessV1,
} from '../application/tracking-read.types'
import type { TrackingStoredFactValueV1 } from '../application/tracking.types'
import {
  projectEvaluationSnapshot,
  projectFactValue,
  type ProgressFactRow,
} from './prisma-fact.persistence'

type Client = Parameters<Parameters<PrismaClientProvider['withClient']>[0]>[0]

const MAX_GOALS = 200
const MAX_MATERIALIZED_UNITS = 10_000
const MAX_CURRENT_RECORDS = 10_000

export type TrackingReadBoundCounts = {
  readonly goals: number
  readonly fixedExpectations: number
  readonly flexiblePeriods: number
  readonly currentRecords: number
}

export function assertTrackingReadBounds(
  counts: TrackingReadBoundCounts,
): void {
  if (
    counts.goals > MAX_GOALS ||
    counts.fixedExpectations + counts.flexiblePeriods >
      MAX_MATERIALIZED_UNITS ||
    counts.currentRecords > MAX_CURRENT_RECORDS
  ) {
    throw new Error('Tracking read model exceeds its bounded input')
  }
}

export type TrackingReadPhase = 'header' | 'publication'
export type TrackingReadObserver = (
  phase: TrackingReadPhase,
) => void | Promise<void>

type HeaderRow = {
  readonly plan_month_id: string
  readonly status: string
  readonly lifecycle_revision: bigint
  readonly facts_revision: bigint
  readonly active_publication_id: string | null
  readonly draft_focus: string
  readonly draft_revision: bigint
  readonly publication_id: string | null
  readonly publication_revision: bigint | null
  readonly publication_focus: string | null
  readonly active_local_date: string | null
  readonly late_publication: boolean | null
  readonly calendar_formula_version: string | null
  readonly evaluation_formula_version: string | null
}

type GoalRow = {
  readonly plan_goal_snapshot_id: string
  readonly source_goal_series_id: string
  readonly title: string
  readonly why: string
  readonly category: string
  readonly display_order: number
  readonly scope_kind: 'personal' | 'shared'
  readonly owner_member_id: string | null
  readonly config: unknown
  readonly calendar: unknown
}

type ExpectationRow = {
  readonly fixed_expectation_id: string
  readonly plan_goal_snapshot_id: string
  readonly expectation_date: string
  readonly component_kind: 'goal' | 'checkpoint' | 'checklist_item'
  readonly component_id: string | null
}

type PeriodRow = {
  readonly flexible_period_id: string
  readonly plan_goal_snapshot_id: string
  readonly period_kind: 'weekly' | 'monthly' | 'weekly_planned_task'
  readonly ordinal: number
  readonly period_start: string
  readonly period_end: string
  readonly period_days: number | null
  readonly active_dates: readonly string[]
  readonly eligible_dates: readonly string[]
  readonly period_target: number
}

type FactRow = ProgressFactRow & {
  readonly plan_goal_snapshot_id: string
  readonly revision_kind: 'recorded' | 'tombstoned'
  readonly after_facts_revision: bigint
}

type ClosureRow = {
  readonly local_date: string
  readonly action_id: string
  readonly after_facts_revision: bigint
  readonly occurred_at: Date
  readonly closed_count: number
}

type ProjectedGoal = {
  readonly row: GoalRow
  readonly config: GoalConfigV1
  readonly calendar: PublicationCalendar
  readonly evaluation: ReturnType<typeof projectEvaluationSnapshot>
  readonly evaluationFacts: readonly GoalEvaluationFactV1[]
  readonly viewerAccess: TrackingViewerAccessV1
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

function dateAt(year: number, month: number, day: number): Date {
  const value = new Date(0)
  value.setUTCHours(0, 0, 0, 0)
  value.setUTCFullYear(year, month, day)
  return value
}

function localDate(value: Date): string {
  const year = String(value.getUTCFullYear()).padStart(4, '0')
  const month = String(value.getUTCMonth() + 1).padStart(2, '0')
  const day = String(value.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function monthDates(targetMonth: string): readonly string[] {
  const [yearText, monthText] = targetMonth.split('-')
  const year = Number(yearText)
  const monthIndex = Number(monthText) - 1
  const end = dateAt(year, monthIndex + 1, 0).getUTCDate()
  return Object.freeze(
    Array.from({ length: end }, (_, index) =>
      localDate(dateAt(year, monthIndex, index + 1)),
    ),
  )
}

function addDays(value: string, amount: number): string {
  const [yearText, monthText, dayText] = value.split('-')
  const date = dateAt(Number(yearText), Number(monthText) - 1, Number(dayText))
  date.setUTCDate(date.getUTCDate() + amount)
  return localDate(date)
}

export function previousTrackingAsOf(
  monthStart: string,
  asOfLocalDate: string,
): string | null {
  return asOfLocalDate <= monthStart ? null : addDays(asOfLocalDate, -1)
}

export function isWithinTrackingCorrectionDeadline(
  queryLocalDate: string,
  monthEnd: string,
): boolean {
  const [queryYear, queryMonth, queryDay] = queryLocalDate
    .split('-')
    .map(Number)
  const [endYear, endMonth, endDay] = monthEnd.split('-').map(Number)
  const query = dateAt(queryYear!, queryMonth! - 1, queryDay!).getTime()
  const end = dateAt(endYear!, endMonth! - 1, endDay!).getTime()
  return query <= end + 3 * 24 * 60 * 60 * 1_000
}

function minimum(left: string, right: string): string {
  return left < right ? left : right
}

function groupEvaluationFacts(
  rows: readonly FactRow[],
  projected: ReturnType<typeof projectEvaluationSnapshot>,
): readonly GoalEvaluationFactV1[] {
  const recorded = rows.filter((row) => row.revision_kind === 'recorded')
  const groups = new Map<string, FactRow[]>()
  for (const row of recorded) {
    const key =
      row.component_kind === 'checklist_item'
        ? [row.local_date, 'top-level-checklist'].join(':')
        : [
            row.local_date,
            row.fixed_expectation_id ?? '',
            row.flexible_period_id ?? '',
            row.component_kind ?? '',
            row.component_id ?? '',
          ].join(':')
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [row])
    else group.push(row)
  }

  const facts: GoalEvaluationFactV1[] = []
  const checkpointsByDate = new Map<
    string,
    { readonly checkpointId: string; readonly value: GoalFactValueV1 }[]
  >()
  for (const group of groups.values()) {
    const first = group[0]!
    if (first.component_kind === 'checklist_item') {
      group.sort(
        (left, right) =>
          (projected.checklistItemOrder.get(
            left.checklist_item_id ?? left.component_id ?? '',
          ) ?? -1) -
          (projected.checklistItemOrder.get(
            right.checklist_item_id ?? right.component_id ?? '',
          ) ?? -1),
      )
    } else if (first.fact_kind === 'or_variant') {
      group.sort(
        (left, right) =>
          (projected.variantOrder.get(left.or_variant_id ?? '') ?? -1) -
          (projected.variantOrder.get(right.or_variant_id ?? '') ?? -1),
      )
    }
    const value = projectFactValue(group)
    if (first.component_kind === 'checkpoint') {
      if (first.component_id === null) {
        throw new Error('Stored checkpoint fact identity is invalid')
      }
      const checkpoint = { checkpointId: first.component_id, value }
      const values = checkpointsByDate.get(first.local_date)
      if (values === undefined)
        checkpointsByDate.set(first.local_date, [checkpoint])
      else values.push(checkpoint)
    } else if (first.fixed_expectation_id !== null) {
      facts.push({
        kind: 'fixed',
        expectationDate: first.local_date,
        value,
      })
    } else if (
      first.fact_kind === 'weekly_task_result' &&
      first.flexible_period_id !== null &&
      first.period_start !== null &&
      first.period_end !== null &&
      value.kind === 'boolean'
    ) {
      facts.push({
        kind: 'weekly_planned_task',
        periodStart: first.period_start,
        periodEnd: first.period_end,
        result: value.result,
      })
    } else if (first.flexible_period_id !== null) {
      facts.push({
        kind: 'quota_occurrence',
        localDate: first.local_date,
        value,
      })
    } else {
      throw new Error('Stored fact calendar identity is invalid')
    }
  }
  for (const [expectationDate, checkpoints] of checkpointsByDate) {
    checkpoints.sort(
      (left, right) =>
        (projected.checkpointOrder.get(left.checkpointId) ?? -1) -
        (projected.checkpointOrder.get(right.checkpointId) ?? -1),
    )
    facts.push({ kind: 'fixed_checkpoints', expectationDate, checkpoints })
  }
  facts.sort((left, right) => {
    const leftDate =
      left.kind === 'fixed' || left.kind === 'fixed_checkpoints'
        ? left.expectationDate
        : left.kind === 'quota_occurrence'
          ? left.localDate
          : left.periodStart
    const rightDate =
      right.kind === 'fixed' || right.kind === 'fixed_checkpoints'
        ? right.expectationDate
        : right.kind === 'quota_occurrence'
          ? right.localDate
          : right.periodStart
    return (
      leftDate.localeCompare(rightDate) || left.kind.localeCompare(right.kind)
    )
  })
  return Object.freeze(facts)
}

function effectiveFacts(rows: readonly FactRow[]): readonly FactRow[] {
  const typedRecordedExpectations = new Set(
    rows
      .filter(
        (row) =>
          row.fixed_expectation_id !== null &&
          row.fact_kind !== 'fixed_not_done' &&
          row.revision_kind === 'recorded',
      )
      .map((row) => row.fixed_expectation_id!),
  )
  return rows.filter(
    (row) =>
      row.fact_kind !== 'fixed_not_done' ||
      row.fixed_expectation_id === null ||
      !typedRecordedExpectations.has(row.fixed_expectation_id),
  )
}

function storedRating(value: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) {
    throw new Error('Stored rating fact is outside the safe-integer domain')
  }
  return result
}

function factValue(row: FactRow): TrackingStoredFactValueV1 | null {
  if (row.revision_kind === 'tombstoned') return null
  switch (row.fact_kind) {
    case 'boolean':
    case 'weekly_task_result':
      if (row.boolean_result === null) throw new Error('Invalid Boolean fact')
      return { kind: 'boolean', result: row.boolean_result }
    case 'quantity_add':
    case 'quantity_latest':
      if (row.quantity_value === null) throw new Error('Invalid quantity fact')
      return { kind: 'quantity', value: row.quantity_value }
    case 'actual_time':
      if (row.actual_time_value === null) throw new Error('Invalid time fact')
      return { kind: 'actual_time', value: row.actual_time_value }
    case 'rating':
      if (row.rating_value === null) throw new Error('Invalid rating fact')
      return { kind: 'rating', value: storedRating(row.rating_value) }
    case 'text':
      if (row.text_value === null || row.text_result === null) {
        throw new Error('Invalid text fact')
      }
      return {
        kind: 'text',
        text: row.text_value,
        result: row.text_result,
      }
    case 'checklist_item':
      if (row.checklist_item_state === null) {
        throw new Error('Invalid checklist fact')
      }
      return { kind: 'checklist_item', state: row.checklist_item_state }
    case 'or_variant':
      if (row.or_variant_value === null) throw new Error('Invalid OR fact')
      return { kind: 'or_variant', value: row.or_variant_value }
    case 'fixed_not_done':
      if (row.fixed_outcome !== 'not_done') {
        throw new Error('Invalid fixed not_done fact')
      }
      return { kind: 'fixed_not_done', result: 'not_done' }
  }
}

function readFact(row: FactRow): TrackingFactReadV1 {
  return {
    factRecordId: row.fact_record_id,
    revision: row.revision_number,
    factKind: row.fact_kind,
    contributionId: row.contribution_id,
    checklistItemId: row.checklist_item_id,
    orVariantId: row.or_variant_id,
    revisionKind: row.revision_kind,
    value: factValue(row),
    recordedByMemberId: row.recorded_by_member_id,
    recordedBySystemActorId: row.recorded_by_system_actor_id,
  }
}

function decimalInteger(value: string, precision: number): bigint {
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(`${whole}${fraction.padEnd(precision, '0')}`)
}

function quantityTotal(value: GoalFactValueV1, precision: number): bigint {
  if (value.kind === 'quantity_latest') {
    return decimalInteger(value.value, precision)
  }
  if (value.kind !== 'quantity_add') return 0n
  return value.contributions.reduce(
    (sum, item) => sum + decimalInteger(item.value, precision),
    0n,
  )
}

function insideTime(value: string, start: string, end: string): boolean {
  return start < end
    ? value >= start && value <= end
    : value >= start || value <= end
}

function expectationState(
  goal: ProjectedGoal,
  componentKind: ExpectationRow['component_kind'],
  componentId: string | null,
  rows: readonly FactRow[],
): TrackingExpectationStateV1 {
  const recorded = rows.filter((row) => row.revision_kind === 'recorded')
  if (recorded.length === 0) return 'no_data'
  if (recorded.some((row) => row.fact_kind === 'fixed_not_done')) {
    return 'not_done'
  }
  if (componentKind === 'checklist_item') {
    const row = recorded.find((item) => item.checklist_item_id === componentId)
    return row?.checklist_item_state ?? 'no_data'
  }
  const value = projectFactValue(recorded)
  const measurement = goal.evaluation.snapshot.measurement
  const satisfaction =
    componentKind === 'checkpoint'
      ? (goal.evaluation.snapshot.checkpoints?.items.find(
          (item) => item.checkpointId === componentId,
        )?.satisfaction ?? null)
      : null
  const effectiveKind = satisfaction?.kind ?? measurement.kind
  switch (effectiveKind) {
    case 'boolean':
      return value.kind === 'boolean' ? value.result : 'no_data'
    case 'quantity': {
      if (
        measurement.kind !== 'quantity' ||
        (value.kind !== 'quantity_add' && value.kind !== 'quantity_latest')
      ) {
        return 'no_data'
      }
      const target =
        satisfaction?.kind === 'quantity'
          ? satisfaction.target
          : measurement.target
      if (target === null) return 'done'
      return quantityTotal(value, measurement.precision) >=
        decimalInteger(target, measurement.precision)
        ? 'done'
        : 'partial'
    }
    case 'actual_time': {
      if (measurement.kind !== 'actual_time' || value.kind !== 'actual_time') {
        return 'no_data'
      }
      const start =
        satisfaction?.kind === 'actual_time'
          ? satisfaction.start
          : measurement.start
      const end =
        satisfaction?.kind === 'actual_time'
          ? satisfaction.end
          : measurement.end
      return insideTime(value.value, start, end) ? 'done' : 'not_done'
    }
    case 'rating':
      return value.kind === 'rating' ? 'done' : 'no_data'
    case 'text':
      return value.kind === 'text' ? value.result : 'no_data'
    case 'checklist': {
      if (measurement.kind !== 'checklist' || value.kind !== 'checklist') {
        return 'no_data'
      }
      if (value.items.length < measurement.items.length) return 'partial'
      return value.items.every((item) => item.state === 'done')
        ? 'done'
        : 'not_done'
    }
    case 'any_of': {
      if (measurement.kind !== 'any_of' || value.kind !== 'any_of') {
        return 'no_data'
      }
      const variants = new Map(
        measurement.variants.map((item) => [item.variantId, item]),
      )
      for (const item of value.variants) {
        const variant = variants.get(item.variantId)
        if (
          variant !== undefined &&
          decimalInteger(item.value, variant.precision) >=
            decimalInteger(variant.target, variant.precision)
        ) {
          return 'done'
        }
      }
      return 'partial'
    }
  }
}

function phase(
  status: TrackingPublishedReadV1['monthStatus'],
  queryLocalDate: string,
  activeLocalDate: string,
  monthEnd: string,
): TrackingMonthPhaseV1 {
  if (status === 'closed') return 'closed'
  if (status === 'grace') return 'grace'
  if (queryLocalDate < activeLocalDate) return 'future'
  return queryLocalDate > monthEnd ? 'grace' : 'active'
}

function progressAt(
  goal: ProjectedGoal,
  targetMonth: string,
  activeLocalDate: string,
  asOfLocalDate: string,
): GoalProgressResult {
  return evaluateGoalProgress({
    snapshot: goal.evaluation.snapshot,
    calendarInput: {
      targetMonth,
      activeLocalDate,
      timeZone: 'Asia/Yekaterinburg',
      repetition: goal.evaluation.repetition,
    },
    calendar: {
      formulaVersion: 'planner.calendar-targets.v1',
      eligible: true,
      calendar: goal.calendar,
      issues: [],
    },
    facts: goal.evaluationFacts.filter((fact) => {
      const date =
        fact.kind === 'fixed' || fact.kind === 'fixed_checkpoints'
          ? fact.expectationDate
          : fact.kind === 'quota_occurrence'
            ? fact.localDate
            : fact.periodStart
      return date <= asOfLocalDate
    }),
    asOfLocalDate,
  })
}

function coverageDelta(
  current: { readonly filled: string; readonly applicable: string },
  previous: { readonly filled: string; readonly applicable: string },
): { readonly filled: string; readonly applicable: string } {
  return {
    filled: (BigInt(current.filled) - BigInt(previous.filled)).toString(10),
    applicable: (
      BigInt(current.applicable) - BigInt(previous.applicable)
    ).toString(10),
  }
}

function stateFromCoverage(
  localDateValue: string,
  queryLocalDate: string,
  activeLocalDate: string,
  coverage: { readonly filled: string; readonly applicable: string },
): TrackingDayStateV1 {
  if (localDateValue > queryLocalDate) return 'future'
  if (localDateValue < activeLocalDate || coverage.applicable === '0') {
    return 'not_applicable'
  }
  if (coverage.filled === '0') return 'no_data'
  if (BigInt(coverage.filled) < BigInt(coverage.applicable)) return 'partial'
  return 'filled'
}

function stateFromFlexible(
  localDateValue: string,
  queryLocalDate: string,
  activeLocalDate: string,
  applicable: boolean,
  periods: readonly TrackingFlexiblePeriodV1[],
): TrackingDayStateV1 {
  if (localDateValue > queryLocalDate) return 'future'
  if (localDateValue < activeLocalDate || !applicable) {
    return 'not_applicable'
  }
  const eligible = periods.filter((period) => period.eligibleOnDate)
  if (eligible.every((period) => period.state === 'no_data')) return 'no_data'
  if (
    eligible.every(
      (period) => period.state === 'done' || period.state === 'not_done',
    )
  ) {
    return 'filled'
  }
  return 'partial'
}

function aggregateDayState(
  localDateValue: string,
  queryLocalDate: string,
  activeLocalDate: string,
  goals: readonly TrackingDayGoalV1[],
): TrackingDayStateV1 {
  if (localDateValue > queryLocalDate) return 'future'
  if (localDateValue < activeLocalDate) return 'not_applicable'
  const applicable = goals.filter((goal) => goal.applicable)
  if (applicable.length === 0) return 'not_applicable'
  if (applicable.every((goal) => goal.state === 'no_data')) return 'no_data'
  if (applicable.every((goal) => goal.state === 'filled')) return 'filled'
  return 'partial'
}

export class PrismaTrackingReadPersistence implements TrackingReadPersistencePort {
  public constructor(
    private readonly database: PrismaClientProvider,
    private readonly afterReadPhase: TrackingReadObserver = () => undefined,
  ) {}

  public getMonth(
    input: GetTrackingReadPersistenceInput,
  ): Promise<TrackingMonthStateV1> {
    return this.database.withClient(async (client) => {
      await client.$executeRawUnsafe(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      )
      const header = await this.header(client, input)
      await this.afterReadPhase('header')
      if (header === undefined) {
        return freeze({
          state: 'no_plan',
          queryLocalDate: input.queryLocalDate,
          targetMonth: input.targetMonth,
        })
      }
      if (header.status === 'draft') {
        return freeze({
          state: 'draft',
          queryLocalDate: input.queryLocalDate,
          targetMonth: input.targetMonth,
          planMonthId: header.plan_month_id,
          lifecycleRevision: header.lifecycle_revision,
          draftRevision: header.draft_revision,
          focus: header.draft_focus,
        })
      }
      if (
        !['published', 'grace', 'closed'].includes(header.status) ||
        header.publication_id === null ||
        header.active_publication_id !== header.publication_id ||
        header.publication_revision === null ||
        header.publication_focus === null ||
        header.active_local_date === null ||
        header.late_publication === null ||
        header.calendar_formula_version !== 'planner.calendar-targets.v1' ||
        header.evaluation_formula_version !== 'planner.goal-evaluation.v1'
      ) {
        throw new Error('Stored tracking month header is invalid')
      }
      const result = await this.published(
        client,
        input,
        header as HeaderRow & {
          readonly status: 'published' | 'grace' | 'closed'
          readonly publication_id: string
          readonly publication_revision: bigint
          readonly publication_focus: string
          readonly active_local_date: string
          readonly late_publication: boolean
        },
      )
      await this.afterReadPhase('publication')
      return result
    })
  }

  private async header(
    client: Client,
    input: GetTrackingReadPersistenceInput,
  ): Promise<HeaderRow | undefined> {
    const rows = await client.$queryRaw<HeaderRow[]>`
      SELECT month.id::text plan_month_id, month.status,
             month.revision lifecycle_revision,
             month.facts_revision,
             month.active_publication_id::text,
             draft.focus draft_focus, draft.revision draft_revision,
             publication.id::text publication_id,
             publication.publication_revision,
             publication.focus publication_focus,
             publication.active_local_date::text,
             publication.late_publication,
             publication.calendar_formula_version,
             publication.evaluation_formula_version
        FROM plan_months month
        JOIN plan_drafts draft ON draft.plan_month_id = month.id
        LEFT JOIN plan_publications publication
          ON publication.id = month.active_publication_id
       WHERE month.space_id = ${input.spaceId}::uuid
         AND month.month_start = ${`${input.targetMonth}-01`}::date
    `
    if (rows.length > 1) throw new Error('Duplicate plan month')
    return rows[0]
  }

  private async published(
    client: Client,
    input: GetTrackingReadPersistenceInput,
    header: HeaderRow & {
      readonly status: 'published' | 'grace' | 'closed'
      readonly publication_id: string
      readonly publication_revision: bigint
      readonly publication_focus: string
      readonly active_local_date: string
      readonly late_publication: boolean
    },
  ): Promise<TrackingPublishedReadV1> {
    const [goalRows, expectations, periods, storedFacts, closures] =
      await Promise.all([
        client.$queryRaw<GoalRow[]>`
        SELECT id::text plan_goal_snapshot_id,
               goal_series_id::text source_goal_series_id,
               title, why, category, display_order,
               scope_kind, owner_member_id::text, config, calendar
          FROM plan_goal_snapshots
         WHERE publication_id = ${header.publication_id}::uuid
         ORDER BY display_order, id
         LIMIT ${MAX_GOALS + 1}
      `,
        client.$queryRaw<ExpectationRow[]>`
        SELECT id::text fixed_expectation_id,
               plan_goal_snapshot_id::text,
               expectation_date::text, component_kind,
               component_id::text
          FROM fixed_expectations
         WHERE publication_id = ${header.publication_id}::uuid
         ORDER BY expectation_date, plan_goal_snapshot_id,
                  component_kind, component_id, id
         LIMIT ${MAX_MATERIALIZED_UNITS + 1}
      `,
        client.$queryRaw<PeriodRow[]>`
        SELECT id::text flexible_period_id,
               plan_goal_snapshot_id::text, period_kind, ordinal,
               period_start::text, period_end::text, period_days,
               active_dates::text[], eligible_dates::text[], period_target
          FROM flexible_periods
         WHERE publication_id = ${header.publication_id}::uuid
         ORDER BY plan_goal_snapshot_id, ordinal, id
         LIMIT ${MAX_MATERIALIZED_UNITS + 1}
      `,
        client.$queryRaw<FactRow[]>`
        SELECT record.id::text fact_record_id,
               record.plan_goal_snapshot_id::text,
               record.fact_kind,
               record.local_date::text, record.contribution_id::text,
               record.checklist_item_id::text,
               record.or_variant_id::text,
               record.fixed_expectation_id::text,
               record.flexible_period_id::text,
               revision.revision_number, revision.revision_kind,
               revision.boolean_result, revision.quantity_value,
               to_char(revision.actual_time_value, 'HH24:MI') actual_time_value,
               revision.rating_value::text rating_value,
               revision.text_value, revision.text_result,
               revision.checklist_item_state,
               revision.or_variant_value,
               revision.fixed_outcome,
               revision.recorded_by_member_id::text,
               revision.recorded_by_system_actor_id,
               expectation.component_kind,
               expectation.component_id::text,
               period.period_start::text, period.period_end::text,
               action.after_facts_revision
          FROM tracking_fact_records record
          JOIN tracking_fact_revisions revision
            ON revision.id = record.current_revision_id
          JOIN tracking_fact_changes change
            ON change.after_revision_id = revision.id
          JOIN tracking_action_groups action ON action.id = change.action_id
          LEFT JOIN fixed_expectations expectation
            ON expectation.id = record.fixed_expectation_id
          LEFT JOIN flexible_periods period
            ON period.id = record.flexible_period_id
         WHERE record.publication_id = ${header.publication_id}::uuid
         ORDER BY action.after_facts_revision, record.id
         LIMIT ${MAX_CURRENT_RECORDS + 1}
      `,
        client.$queryRaw<ClosureRow[]>`
        SELECT detail.local_date::text, detail.action_id::text,
               action.after_facts_revision, action.occurred_at,
               detail.closed_count
          FROM tracking_day_closures detail
          JOIN tracking_action_groups action ON action.id = detail.action_id
         WHERE detail.publication_id = ${header.publication_id}::uuid
           AND detail.member_id = ${input.memberId}::uuid
         ORDER BY detail.local_date
      `,
      ])
    const facts = effectiveFacts(storedFacts)
    assertTrackingReadBounds({
      goals: goalRows.length,
      fixedExpectations: expectations.length,
      flexiblePeriods: periods.length,
      currentRecords: storedFacts.length,
    })

    const factsByGoal = new Map<string, FactRow[]>()
    for (const row of facts) {
      const values = factsByGoal.get(row.plan_goal_snapshot_id)
      if (values === undefined)
        factsByGoal.set(row.plan_goal_snapshot_id, [row])
      else values.push(row)
    }
    const goals: ProjectedGoal[] = goalRows.map((row) => {
      const stored = snapshotStoredDraftGoalConfig(row.config)
      const validated = validateGoalConfig(row.plan_goal_snapshot_id, stored)
      if (!validated.publishable) throw new Error('Published config is invalid')
      const evaluation = projectEvaluationSnapshot(row.config)
      const goalFacts = factsByGoal.get(row.plan_goal_snapshot_id) ?? []
      const viewerAccess: TrackingViewerAccessV1 =
        row.scope_kind === 'shared'
          ? 'shared'
          : row.owner_member_id === input.memberId
            ? 'personal_owner'
            : 'partner_read_only'
      return {
        row,
        config: validated.config,
        calendar: row.calendar as PublicationCalendar,
        evaluation,
        evaluationFacts: groupEvaluationFacts(goalFacts, evaluation),
        viewerAccess,
      }
    })
    const expectationsByGoal = new Map<string, ExpectationRow[]>()
    for (const row of expectations) {
      const values = expectationsByGoal.get(row.plan_goal_snapshot_id)
      if (values === undefined)
        expectationsByGoal.set(row.plan_goal_snapshot_id, [row])
      else values.push(row)
    }
    const periodsByGoal = new Map<string, PeriodRow[]>()
    for (const row of periods) {
      const values = periodsByGoal.get(row.plan_goal_snapshot_id)
      if (values === undefined)
        periodsByGoal.set(row.plan_goal_snapshot_id, [row])
      else values.push(row)
    }
    const factsByExpectation = new Map<string, FactRow[]>()
    const factsByPeriodAndDate = new Map<string, FactRow[]>()
    const factsByPeriod = new Map<string, FactRow[]>()
    for (const row of facts) {
      if (row.fixed_expectation_id !== null) {
        const values = factsByExpectation.get(row.fixed_expectation_id)
        if (values === undefined)
          factsByExpectation.set(row.fixed_expectation_id, [row])
        else values.push(row)
      }
      if (row.flexible_period_id !== null) {
        const periodValues = factsByPeriod.get(row.flexible_period_id)
        if (periodValues === undefined)
          factsByPeriod.set(row.flexible_period_id, [row])
        else periodValues.push(row)
        const key = `${row.flexible_period_id}:${row.local_date}`
        const values = factsByPeriodAndDate.get(key)
        if (values === undefined) factsByPeriodAndDate.set(key, [row])
        else values.push(row)
      }
    }
    const closuresByDate = new Map(
      closures.map((row) => [row.local_date, row] as const),
    )

    const allDates = monthDates(input.targetMonth)
    const dates =
      input.selectedLocalDate === null ? allDates : [input.selectedLocalDate]
    const monthEnd = allDates.at(-1)!
    const rootAsOf = minimum(input.queryLocalDate, monthEnd)
    const effectivePhase = phase(
      header.status,
      input.queryLocalDate,
      header.active_local_date,
      monthEnd,
    )
    const progressCache = new Map<string, ReturnType<typeof progressAt>>()
    const readProgress = (
      goal: ProjectedGoal,
      asOf: string,
    ): GoalProgressResult => {
      const key = `${goal.row.plan_goal_snapshot_id}:${asOf}`
      const existing = progressCache.get(key)
      if (existing !== undefined) return existing
      const value = progressAt(
        goal,
        input.targetMonth,
        header.active_local_date,
        asOf,
      )
      progressCache.set(key, value)
      return value
    }
    const readGoals: TrackingGoalReadV1[] = goals.map((goal) => ({
      planGoalSnapshotId: goal.row.plan_goal_snapshot_id,
      sourceGoalSeriesId: goal.row.source_goal_series_id,
      title: goal.row.title,
      why: goal.row.why,
      category: goal.row.category,
      displayOrder: goal.row.display_order,
      config: goal.config,
      calendar: goal.calendar,
      viewerAccess: goal.viewerAccess,
      progress: readProgress(goal, rootAsOf),
    }))

    const monthStart = allDates[0]!
    const readDays: TrackingDayReadV1[] = dates.map((date) => {
      const dayGoals: TrackingDayGoalV1[] = []
      let dayFilled = 0n
      let dayApplicable = 0n
      for (const goal of goals) {
        const fixedRows = (
          expectationsByGoal.get(goal.row.plan_goal_snapshot_id) ?? []
        ).filter((row) => row.expectation_date === date)
        const periodRows = (
          periodsByGoal.get(goal.row.plan_goal_snapshot_id) ?? []
        ).filter((row) => date >= row.period_start && date <= row.period_end)
        if (fixedRows.length === 0 && periodRows.length === 0) continue

        const asOf = minimum(date, input.queryLocalDate)
        const current = readProgress(goal, asOf)
        const previousAsOf = previousTrackingAsOf(monthStart, asOf)

        const fixed: TrackingFixedExpectationV1[] = fixedRows.map((row) => {
          const rows = factsByExpectation.get(row.fixed_expectation_id) ?? []
          return {
            fixedExpectationId: row.fixed_expectation_id,
            componentKind: row.component_kind,
            componentId: row.component_id,
            state: expectationState(
              goal,
              row.component_kind,
              row.component_id,
              rows,
            ),
            facts: rows.map(readFact),
          }
        })
        const flexible: TrackingFlexiblePeriodV1[] = periodRows.map((row) => {
          const eligibleOnDate =
            row.period_kind === 'weekly_planned_task'
              ? date >= header.active_local_date
              : row.eligible_dates.includes(date)
          const rows =
            row.period_kind === 'weekly_planned_task'
              ? (factsByPeriod.get(row.flexible_period_id) ?? [])
              : (factsByPeriodAndDate.get(
                  `${row.flexible_period_id}:${date}`,
                ) ?? [])
          const actualProgress =
            current.periods.find(
              (period) =>
                period.periodStart === row.period_start &&
                period.periodEnd === row.period_end,
            )?.actualEquivalentOccurrences ?? null
          const expectedProgress =
            row.period_kind === 'weekly_planned_task'
              ? null
              : calculateExpectedPace({
                  period: {
                    cadence: row.period_kind,
                    ordinal: row.ordinal,
                    periodStart: row.period_start,
                    periodEnd: row.period_end,
                    periodDays: row.period_days!,
                    activeDates: row.active_dates,
                    eligibleDates: row.eligible_dates,
                    periodTarget: row.period_target,
                  },
                  asOfLocalDate: asOf,
                })
          return {
            flexiblePeriodId: row.flexible_period_id,
            periodKind: row.period_kind,
            ordinal: row.ordinal,
            periodStart: row.period_start,
            periodEnd: row.period_end,
            periodTarget: row.period_target,
            eligibleOnDate,
            expectedProgress,
            actualProgress,
            state:
              rows.length === 0
                ? 'no_data'
                : expectationState(goal, 'goal', null, rows),
            facts: rows.map(readFact),
          }
        })
        const coverage =
          fixedRows.length === 0
            ? { filled: '0', applicable: '0' }
            : coverageDelta(
                current.coverage,
                previousAsOf === null
                  ? { filled: '0', applicable: '0' }
                  : readProgress(goal, previousAsOf).coverage,
              )
        if (fixedRows.length !== 0) {
          dayFilled += BigInt(coverage.filled)
          dayApplicable += BigInt(coverage.applicable)
        }
        const applicable =
          date >= header.active_local_date &&
          (fixedRows.length !== 0 ||
            flexible.some((period) => period.eligibleOnDate))
        const writeSupported =
          goal.config.repetition.kind !== 'weekly_planned_task' ||
          periodRows.some(
            (period) =>
              input.queryLocalDate >= header.active_local_date &&
              input.queryLocalDate >= period.period_start &&
              input.queryLocalDate <= period.period_end,
          )
        const writable =
          applicable &&
          writeSupported &&
          goal.viewerAccess !== 'partner_read_only' &&
          date <= input.queryLocalDate &&
          input.queryLocalDate >= header.active_local_date &&
          isWithinTrackingCorrectionDeadline(input.queryLocalDate, monthEnd) &&
          ['active', 'grace'].includes(effectivePhase)
        const state =
          fixedRows.length === 0
            ? stateFromFlexible(
                date,
                input.queryLocalDate,
                header.active_local_date,
                applicable,
                flexible,
              )
            : stateFromCoverage(
                date,
                input.queryLocalDate,
                header.active_local_date,
                coverage,
              )
        dayGoals.push({
          planGoalSnapshotId: goal.row.plan_goal_snapshot_id,
          applicable,
          writable,
          state,
          coverage,
          progress: current,
          fixedExpectations: fixed,
          flexiblePeriods: flexible,
        })
      }
      const coverage = {
        filled: dayFilled.toString(10),
        applicable: dayApplicable.toString(10),
      }
      return {
        localDate: date,
        closure: (() => {
          const closure = closuresByDate.get(date)
          return closure === undefined
            ? {
                state: 'open' as const,
                dayCloseId: null,
                revision: null,
                closedAt: null,
                closedCount: null,
              }
            : {
                state: 'closed' as const,
                dayCloseId: closure.action_id,
                revision: closure.after_facts_revision,
                closedAt: new Date(closure.occurred_at.getTime()),
                closedCount: closure.closed_count,
              }
        })(),
        state: aggregateDayState(
          date,
          input.queryLocalDate,
          header.active_local_date,
          dayGoals,
        ),
        coverage,
        goals: dayGoals,
      }
    })

    return freeze({
      state: 'published',
      queryLocalDate: input.queryLocalDate,
      targetMonth: input.targetMonth,
      planMonthId: header.plan_month_id,
      lifecycleRevision: header.lifecycle_revision,
      factsRevision: header.facts_revision,
      monthStatus: header.status,
      phase: effectivePhase,
      publicationId: header.publication_id,
      publicationRevision: header.publication_revision,
      activeLocalDate: header.active_local_date,
      latePublication: header.late_publication,
      focus: header.publication_focus,
      goals: readGoals,
      days: readDays,
    })
  }
}
