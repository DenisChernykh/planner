import { createHash } from 'node:crypto'

import {
  CALENDAR_TARGETS_FORMULA_VERSION,
  GOAL_EVALUATION_FORMULA_VERSION,
  SCORE_COVERAGE_FORMULA_VERSION,
  calculateEligibleCalendar,
  type CalendarRepetitionV1,
  type EligibleCalendar,
} from '@/modules/progress'
import type { CanonicalJsonValue } from '@/shared/application/application-command'
import { canonicalJsonStringify } from '@/shared/application/command-fingerprint'

import type { GoalConfigV1 } from '../domain/goal-config'
import { validateGoalConfig } from './draft-goal-public.contract'
import type { DraftEditorView, DraftGoalView } from './draft-goal.types'

export const PUBLICATION_PREVIEW_SCHEMA_VERSION =
  'planner.publication-preview.v1' as const
export const PUBLICATION_PREVIEW_HASH_VERSION =
  'planner.publication-preview-hash.v1' as const
export const MAX_PUBLICATION_MATERIALIZED_ROWS = 10_000

const MATERIALIZATION_LIMIT_BLOCKER: PublicationPreviewBlocker = Object.freeze({
  planGoalId: null,
  pointer: '/goals',
  code: 'incompatible',
  detail: 'Publication materialization exceeds 10000 rows.',
})

export type PublicationPreviewActivation = {
  readonly mode: 'immediate' | 'scheduled' | 'blocked'
  readonly activeLocalDate: string
  readonly latePublication: boolean
}

export type PublicationPreviewBlocker = {
  readonly planGoalId: string | null
  readonly pointer: string
  readonly code: 'required' | 'empty_collection' | 'incompatible'
  readonly detail: string
}

export type PublicationPreviewGoal = Omit<DraftGoalView, 'configRevision'> & {
  readonly configRevision: string
}

export type PublicationCalculatedTarget = {
  readonly planGoalId: string
  readonly formulaVersion: typeof CALENDAR_TARGETS_FORMULA_VERSION
  readonly calendar: EligibleCalendar
}

export type PublicationPreviewFormulaVersions = {
  readonly calendarTargets: typeof CALENDAR_TARGETS_FORMULA_VERSION
  readonly goalEvaluation: typeof GOAL_EVALUATION_FORMULA_VERSION
  readonly scoreCoverage: typeof SCORE_COVERAGE_FORMULA_VERSION
}

export type PublicationPreviewWithoutHash = {
  readonly schemaVersion: typeof PUBLICATION_PREVIEW_SCHEMA_VERSION
  readonly planMonthId: string
  readonly spaceId: string
  readonly targetMonth: string
  readonly status: 'draft'
  readonly planMonthRevision: string
  readonly draftRevision: string
  readonly previewHashVersion: typeof PUBLICATION_PREVIEW_HASH_VERSION
  readonly activation: PublicationPreviewActivation
  readonly focus: string
  readonly goals: readonly PublicationPreviewGoal[]
  readonly calculatedTargets: readonly PublicationCalculatedTarget[]
  readonly blockers: readonly PublicationPreviewBlocker[]
  readonly formulaVersions: PublicationPreviewFormulaVersions
}

export type PublicationPreview = PublicationPreviewWithoutHash & {
  readonly previewHash: string
}

function freezeData<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freezeData(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor !== undefined && 'value' in descriptor) {
        freezeData(descriptor.value)
      }
    }
    return Object.freeze(value)
  }
  return value
}

function positive(value: bigint): string {
  if (value <= 0n) throw new TypeError('Expected positive bigint')
  return value.toString(10)
}

function nextMonth(targetMonth: string): string {
  const year = Number(targetMonth.slice(0, 4))
  const month = Number(targetMonth.slice(5, 7))
  const nextYear = month === 12 ? year + 1 : year
  const next = month === 12 ? 1 : month + 1
  return `${nextYear.toString().padStart(4, '0')}-${next.toString().padStart(2, '0')}`
}

function activation(
  targetMonth: string,
  today: string,
): {
  readonly activation: PublicationPreviewActivation
  readonly blocker: PublicationPreviewBlocker | null
} {
  const currentMonth = today.slice(0, 7)
  if (targetMonth === currentMonth) {
    return {
      activation: {
        mode: 'immediate',
        activeLocalDate: today,
        latePublication: today.slice(8, 10) !== '01',
      },
      blocker: null,
    }
  }
  if (targetMonth === nextMonth(currentMonth)) {
    return {
      activation: {
        mode: 'scheduled',
        activeLocalDate: `${targetMonth}-01`,
        latePublication: false,
      },
      blocker: null,
    }
  }
  return {
    activation: {
      mode: 'blocked',
      activeLocalDate: `${targetMonth}-01`,
      latePublication: false,
    },
    blocker: {
      planGoalId: null,
      pointer: '/targetMonth',
      code: 'incompatible',
      detail: 'Target month is not current or next.',
    },
  }
}

function repetition(config: GoalConfigV1): CalendarRepetitionV1 {
  const value = config.repetition
  switch (value.kind) {
    case 'daily':
      return { kind: 'daily' }
    case 'weekdays':
      return { kind: 'weekdays', weekdays: [...value.weekdays] }
    case 'weekly':
    case 'monthly':
      return { kind: value.kind, n: value.n }
    case 'one_off':
      return { kind: 'one_off', dueDate: value.dueDate }
    case 'weekly_planned_task':
      return {
        kind: 'weekly_planned_task',
        weekOrdinal: value.weekOrdinal,
      }
  }
}

function detached<T>(value: T): T {
  if (Array.isArray(value)) return value.map(detached) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, detached(item)]),
    ) as T
  }
  return value
}

function goalResponse(
  goal: DraftGoalView,
  blockers: readonly PublicationPreviewBlocker[],
): PublicationPreviewGoal {
  return {
    planGoalId: goal.planGoalId,
    goalDefinitionId: goal.goalDefinitionId,
    goalDefinitionVersionId: goal.goalDefinitionVersionId,
    goalSeriesId: goal.goalSeriesId,
    title: goal.title,
    why: goal.why,
    category: goal.category,
    displayOrder: goal.displayOrder,
    configRevision: positive(goal.configRevision),
    config: detached(goal.config),
    sourceProvenance: detached(goal.sourceProvenance),
    blockers: blockers as PublicationPreviewGoal['blockers'],
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortedBlockers(
  blockers: readonly PublicationPreviewBlocker[],
  goals: readonly DraftGoalView[],
): PublicationPreviewBlocker[] {
  const order = new Map(
    goals.map((goal) => [goal.planGoalId, goal.displayOrder]),
  )
  return [...blockers].sort((left, right) => {
    const goalOrder =
      left.planGoalId === null
        ? right.planGoalId === null
          ? 0
          : -1
        : right.planGoalId === null
          ? 1
          : (order.get(left.planGoalId) ?? 0) -
              (order.get(right.planGoalId) ?? 0) ||
            compareText(left.planGoalId, right.planGoalId)
    return (
      goalOrder ||
      compareText(left.pointer, right.pointer) ||
      compareText(left.code, right.code) ||
      compareText(left.detail, right.detail)
    )
  })
}

function fixedComponentCount(config: GoalConfigV1): number {
  if (config.checkpoints !== null) return config.checkpoints.items.length
  if (config.measurement.kind === 'checklist') {
    return config.measurement.items.length
  }
  return 1
}

function materializedRowCount(
  goals: readonly DraftGoalView[],
  targets: readonly PublicationCalculatedTarget[],
): number {
  const goalById = new Map(goals.map((goal) => [goal.planGoalId, goal]))
  let count = goals.length
  for (const target of targets) {
    if (target.calendar.kind === 'fixed') {
      const goal = goalById.get(target.planGoalId)
      if (goal === undefined) continue
      count +=
        target.calendar.expectationDates.length *
        fixedComponentCount(goal.config as GoalConfigV1)
    } else {
      count += target.calendar.periods.length
    }
    if (count > MAX_PUBLICATION_MATERIALIZED_ROWS) return count
  }
  return count
}

export function publicationPreviewHash(
  value: PublicationPreviewWithoutHash,
): string {
  return createHash('sha256')
    .update(
      canonicalJsonStringify(value as unknown as CanonicalJsonValue),
      'utf8',
    )
    .digest('hex')
}

export function buildPublicationPreview(
  editor: DraftEditorView,
  today: string,
): PublicationPreview {
  const window = activation(editor.targetMonth, today)
  const orderedGoals = [...editor.goals].sort(
    (left, right) =>
      left.displayOrder - right.displayOrder ||
      compareText(left.planGoalId, right.planGoalId),
  )
  const targets: PublicationCalculatedTarget[] = []
  const blockersByGoal = new Map<string, readonly PublicationPreviewBlocker[]>()
  const blockers: PublicationPreviewBlocker[] = [
    ...(window.blocker === null ? [] : [window.blocker]),
  ]
  for (const goal of orderedGoals) {
    const refined = validateGoalConfig(goal.planGoalId, goal.config)
    if (!refined.publishable) {
      blockersByGoal.set(goal.planGoalId, refined.blockers)
      blockers.push(...refined.blockers)
      continue
    }
    const calendar = calculateEligibleCalendar({
      targetMonth: editor.targetMonth,
      activeLocalDate: window.activation.activeLocalDate,
      timeZone: 'Asia/Yekaterinburg',
      repetition: repetition(refined.config),
    })
    if (!calendar.eligible) {
      const goalBlockers = calendar.issues.map((issue) => ({
        planGoalId: goal.planGoalId,
        pointer: issue.pointer,
        code: issue.code,
        detail: issue.detail,
      }))
      blockersByGoal.set(goal.planGoalId, goalBlockers)
      blockers.push(...goalBlockers)
      continue
    }
    blockersByGoal.set(goal.planGoalId, [])
    targets.push({
      planGoalId: goal.planGoalId,
      formulaVersion: calendar.formulaVersion,
      calendar: calendar.calendar,
    })
  }

  if (
    materializedRowCount(orderedGoals, targets) >
    MAX_PUBLICATION_MATERIALIZED_ROWS
  ) {
    blockers.push(MATERIALIZATION_LIMIT_BLOCKER)
  }
  const sorted = sortedBlockers(blockers, orderedGoals)
  const frozenByGoal = new Map<string, readonly PublicationPreviewBlocker[]>()
  for (const goalBlocker of sorted) {
    if (goalBlocker.planGoalId === null) continue
    const values = frozenByGoal.get(goalBlocker.planGoalId) ?? []
    frozenByGoal.set(goalBlocker.planGoalId, [...values, goalBlocker])
  }
  const preimage: PublicationPreviewWithoutHash = {
    schemaVersion: PUBLICATION_PREVIEW_SCHEMA_VERSION,
    planMonthId: editor.planMonthId,
    spaceId: editor.spaceId,
    targetMonth: editor.targetMonth,
    status: editor.status,
    planMonthRevision: positive(editor.planMonthRevision),
    draftRevision: positive(editor.draftRevision),
    previewHashVersion: PUBLICATION_PREVIEW_HASH_VERSION,
    activation: window.activation,
    focus: editor.focus,
    goals: orderedGoals.map((goal) =>
      goalResponse(
        goal,
        frozenByGoal.get(goal.planGoalId) ??
          blockersByGoal.get(goal.planGoalId) ??
          [],
      ),
    ),
    calculatedTargets: targets,
    blockers: sorted,
    formulaVersions: {
      calendarTargets: CALENDAR_TARGETS_FORMULA_VERSION,
      goalEvaluation: GOAL_EVALUATION_FORMULA_VERSION,
      scoreCoverage: SCORE_COVERAGE_FORMULA_VERSION,
    },
  }
  return freezeData({
    ...preimage,
    previewHash: publicationPreviewHash(preimage),
  })
}
