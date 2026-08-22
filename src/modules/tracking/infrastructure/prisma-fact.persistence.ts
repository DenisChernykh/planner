import { randomUUID } from 'node:crypto'

import type {
  CalendarRepetitionV1,
  CalendarWeekday,
  EvaluateGoalProgressInput,
  EvaluationCheckpointSatisfactionV1,
  EvaluationMeasurementV1,
  GoalEvaluationFactV1,
  GoalEvaluationSnapshotV1,
  GoalFactValueV1,
  SuccessfulEligibleCalendarResult,
} from '@/modules/progress'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  FactPersistencePort,
  FactRecordRef,
  GetFactStatePersistenceInput,
  GetGoalProgressPersistenceInput,
  MutateFactPersistenceInput,
  RecordFactPersistenceInput,
  UndoLastOwnActionPersistenceInput,
} from '../application/fact-persistence.port'
import {
  FactRevisionConflictError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  FactUndoUnavailableError,
  FactValueInvalidError,
  TrackingAuthorizationDeniedError,
  TrackingProgressSourceInvalidError,
} from '../application/tracking-errors'
import type {
  FactStateV1,
  FactValueStateV1,
  QuantityAddContributionV1,
} from '../application/tracking.types'

type Client = Parameters<Parameters<PrismaClientProvider['withClient']>[0]>[0]

export type FactWritePhase =
  | 'record'
  | 'revision'
  | 'pointer'
  | 'facts_revision'
  | 'history'
  | 'undo_detail'

export type FactWriteObserver = (phase: FactWritePhase) => void | Promise<void>

type TargetRow = {
  readonly plan_month_id: string
  readonly facts_revision: bigint
  readonly status: string
  readonly lifecycle_mode: 'ordinary' | 'reopened'
  readonly active_publication_id: string | null
  readonly month_start: string
  readonly month_end: string
  readonly active_local_date: string
  readonly space_id: string
  readonly scope_kind: 'personal' | 'shared'
  readonly owner_member_id: string | null
  readonly config: unknown
  readonly fixed_expectation_id: string | null
  readonly flexible_period_id: string | null
  readonly component_kind: 'goal' | 'checkpoint' | 'checklist_item' | null
  readonly component_id: string | null
}

type CurrentRecordRow = {
  readonly id: string
  readonly current_revision_id: string | null
  readonly revision_number: bigint | null
}

type MutationTargetRow = {
  readonly id: string
  readonly fact_kind: StateRow['fact_kind']
  readonly current_revision_id: string
  readonly revision_number: bigint
  readonly revision_kind: 'recorded' | 'tombstoned'
  readonly plan_month_id: string
  readonly facts_revision: bigint
  readonly status: string
  readonly lifecycle_mode: 'ordinary' | 'reopened'
  readonly active_publication_id: string | null
  readonly publication_id: string
  readonly plan_goal_snapshot_id: string
  readonly active_local_date: string
  readonly correction_deadline: string
  readonly space_id: string
  readonly scope_kind: 'personal' | 'shared'
  readonly owner_member_id: string | null
  readonly config: unknown
  readonly or_variant_id: string | null
}

type UndoTargetRow = {
  readonly id: string
  readonly fact_kind: StateRow['fact_kind']
  readonly current_revision_id: string
  readonly revision_number: bigint
  readonly plan_month_id: string
  readonly facts_revision: bigint
  readonly status: string
  readonly lifecycle_mode: 'ordinary' | 'reopened'
  readonly active_publication_id: string | null
  readonly publication_id: string
  readonly plan_goal_snapshot_id: string
  readonly active_local_date: string
  readonly correction_deadline: string
  readonly space_id: string
}

type UndoCandidateRow = {
  readonly action_id: string
  readonly fact_record_id: string
  readonly before_revision_id: string | null
  readonly after_revision_id: string
  readonly source_revision_kind: 'recorded' | 'tombstoned' | null
  readonly boolean_result: 'done' | 'not_done' | null
  readonly quantity_value: string | null
  readonly actual_time_value: string | null
  readonly rating_value: bigint | null
  readonly text_value: string | null
  readonly text_result: 'done' | 'not_done' | null
  readonly checklist_item_state: 'done' | 'not_done' | null
  readonly or_variant_value: string | null
}

type StateRow = {
  readonly fact_record_id: string
  readonly fact_kind:
    | 'boolean'
    | 'quantity_add'
    | 'quantity_latest'
    | 'actual_time'
    | 'rating'
    | 'text'
    | 'checklist_item'
    | 'or_variant'
    | 'fixed_not_done'
    | 'weekly_task_result'
  readonly contribution_id: string | null
  readonly checklist_item_id: string | null
  readonly or_variant_id: string | null
  readonly revision_number: bigint
  readonly revision_kind: 'recorded' | 'tombstoned'
  readonly boolean_result: 'done' | 'not_done' | null
  readonly quantity_value: string | null
  readonly actual_time_value: string | null
  readonly rating_value: string | null
  readonly text_value: string | null
  readonly text_result: 'done' | 'not_done' | null
  readonly checklist_item_state: 'done' | 'not_done' | null
  readonly or_variant_value: string | null
  readonly fixed_outcome: 'not_done' | null
  readonly recorded_by_member_id: string | null
  readonly recorded_by_system_actor_id: 'planner-worker' | null
}

type ProgressHeaderRow = {
  readonly target_month: string
  readonly active_local_date: string
  readonly calendar_formula_version: string
  readonly evaluation_formula_version: string
  readonly config: unknown
  readonly calendar: unknown
}

export type ProgressFactRow = StateRow & {
  readonly local_date: string
  readonly component_kind: 'goal' | 'checkpoint' | 'checklist_item' | null
  readonly component_id: string | null
  readonly fixed_expectation_id: string | null
  readonly flexible_period_id: string | null
  readonly period_start: string | null
  readonly period_end: string | null
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Published fact config is invalid')
  }
  return value as Record<string, unknown>
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item)
    return Object.freeze(value)
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freeze(item)
    return Object.freeze(value)
  }
  return value
}

function memberRecorder(row: StateRow): string {
  if (
    row.recorded_by_member_id === null ||
    row.recorded_by_system_actor_id !== null
  ) {
    throw new Error('Member fact actor is invalid')
  }
  return row.recorded_by_member_id
}

function quantityScale(value: string): number {
  const point = value.indexOf('.')
  return point < 0 ? 0 : value.length - point - 1
}

function storedRating(value: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) {
    throw new Error('Stored rating fact is outside the safe-integer domain')
  }
  return result
}

function exactString(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message)
  return value
}

function exactInteger(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(message)
  return value as number
}

function assertMutationValue(
  target: MutationTargetRow,
  value: MutateFactPersistenceInput['value'],
): void {
  if (value === null) return
  const config = record(target.config)
  const measurement = record(config['measurement'])
  switch (target.fact_kind) {
    case 'boolean':
    case 'weekly_task_result':
      if (value.kind !== 'boolean') throw new FactValueInvalidError()
      return
    case 'quantity_add':
    case 'quantity_latest': {
      if (value.kind !== 'quantity' || measurement['kind'] !== 'quantity') {
        throw new FactValueInvalidError()
      }
      const precision = measurement['precision']
      if (
        !Number.isInteger(precision) ||
        ![0, 1, 2, 3].includes(precision as number) ||
        quantityScale(value.value) > (precision as number)
      ) {
        throw new FactValueInvalidError()
      }
      return
    }
    case 'actual_time':
      if (value.kind !== 'actual_time') throw new FactValueInvalidError()
      return
    case 'rating': {
      if (value.kind !== 'rating' || measurement['kind'] !== 'rating') {
        throw new FactValueInvalidError()
      }
      const minimum = measurement['minimum']
      const maximum = measurement['maximum']
      if (
        !Number.isSafeInteger(minimum) ||
        !Number.isSafeInteger(maximum) ||
        value.value < (minimum as number) ||
        value.value > (maximum as number)
      ) {
        throw new FactValueInvalidError()
      }
      return
    }
    case 'text':
      if (value.kind !== 'text') throw new FactValueInvalidError()
      return
    case 'checklist_item':
      if (value.kind !== 'checklist_item') throw new FactValueInvalidError()
      return
    case 'or_variant': {
      if (
        value.kind !== 'or_variant' ||
        measurement['kind'] !== 'any_of' ||
        target.or_variant_id === null
      ) {
        throw new FactValueInvalidError()
      }
      const variants: unknown = measurement['variants']
      if (!Array.isArray(variants)) throw new FactValueInvalidError()
      const variant = (variants as unknown[]).find(
        (item) => record(item)['variantId'] === target.or_variant_id,
      )
      if (variant === undefined) throw new FactValueInvalidError()
      const precision = record(variant)['precision']
      if (
        !Number.isInteger(precision) ||
        ![0, 1, 2, 3].includes(precision as number) ||
        quantityScale(value.value) > (precision as number)
      ) {
        throw new FactValueInvalidError()
      }
      return
    }
    case 'fixed_not_done':
      throw new FactTargetUnavailableError('unsupported')
  }
}

function projectRepetition(value: unknown): CalendarRepetitionV1 {
  const repetition = record(value)
  switch (repetition['kind']) {
    case 'daily':
      return { kind: 'daily' }
    case 'weekdays':
      if (!Array.isArray(repetition['weekdays'])) {
        throw new Error('Published repetition is invalid')
      }
      return {
        kind: 'weekdays',
        weekdays: repetition['weekdays'] as readonly CalendarWeekday[],
      }
    case 'weekly':
      return {
        kind: 'weekly',
        n: exactString(repetition['n'], 'Published repetition is invalid'),
      }
    case 'monthly':
      return {
        kind: 'monthly',
        n: exactString(repetition['n'], 'Published repetition is invalid'),
      }
    case 'one_off':
      return {
        kind: 'one_off',
        dueDate: exactString(
          repetition['dueDate'],
          'Published repetition is invalid',
        ),
      }
    case 'weekly_planned_task':
      return {
        kind: 'weekly_planned_task',
        weekOrdinal: exactString(
          repetition['weekOrdinal'],
          'Published repetition is invalid',
        ) as '1' | '2' | '3' | '4' | '5',
      }
    default:
      throw new Error('Published repetition is invalid')
  }
}

function projectMeasurement(value: unknown): EvaluationMeasurementV1 {
  const measurement = record(value)
  switch (measurement['kind']) {
    case 'boolean':
      return { kind: 'boolean' }
    case 'quantity':
      return {
        kind: 'quantity',
        mode: exactString(
          measurement['mode'],
          'Published measurement is invalid',
        ) as 'targeted' | 'informational',
        precision: exactInteger(
          measurement['precision'],
          'Published measurement is invalid',
        ) as 0 | 1 | 2 | 3,
        aggregation: exactString(
          measurement['aggregation'],
          'Published measurement is invalid',
        ) as 'add' | 'latest',
        target:
          measurement['target'] === null
            ? null
            : exactString(
                measurement['target'],
                'Published measurement is invalid',
              ),
      }
    case 'actual_time':
      return {
        kind: 'actual_time',
        start: exactString(
          measurement['start'],
          'Published measurement is invalid',
        ),
        end: exactString(
          measurement['end'],
          'Published measurement is invalid',
        ),
      }
    case 'rating':
      return {
        kind: 'rating',
        minimum: exactInteger(
          measurement['minimum'],
          'Published measurement is invalid',
        ),
        maximum: exactInteger(
          measurement['maximum'],
          'Published measurement is invalid',
        ),
      }
    case 'text':
      return { kind: 'text' }
    case 'checklist': {
      const items = measurement['items']
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('Published measurement is invalid')
      }
      return {
        kind: 'checklist',
        items: items.map((item) => ({
          itemId: exactString(
            record(item)['itemId'],
            'Published measurement is invalid',
          ),
        })) as [{ readonly itemId: string }, ...{ readonly itemId: string }[]],
      }
    }
    case 'any_of': {
      const variants = measurement['variants']
      if (!Array.isArray(variants) || variants.length === 0) {
        throw new Error('Published measurement is invalid')
      }
      return {
        kind: 'any_of',
        variants: variants.map((variant) => {
          const item = record(variant)
          return {
            variantId: exactString(
              item['variantId'],
              'Published measurement is invalid',
            ),
            precision: exactInteger(
              item['precision'],
              'Published measurement is invalid',
            ) as 0 | 1 | 2 | 3,
            target: exactString(
              item['target'],
              'Published measurement is invalid',
            ),
          }
        }) as [
          {
            readonly variantId: string
            readonly precision: 0 | 1 | 2 | 3
            readonly target: string
          },
          ...{
            readonly variantId: string
            readonly precision: 0 | 1 | 2 | 3
            readonly target: string
          }[],
        ],
      }
    }
    default:
      throw new Error('Published measurement is invalid')
  }
}

function projectCheckpointSatisfaction(
  value: unknown,
): EvaluationCheckpointSatisfactionV1 {
  const satisfaction = record(value)
  switch (satisfaction['kind']) {
    case 'boolean':
    case 'rating':
    case 'text':
    case 'checklist':
    case 'any_of':
      return { kind: satisfaction['kind'] }
    case 'quantity':
      return {
        kind: 'quantity',
        target: exactString(
          satisfaction['target'],
          'Published checkpoint is invalid',
        ),
      }
    case 'actual_time':
      return {
        kind: 'actual_time',
        start: exactString(
          satisfaction['start'],
          'Published checkpoint is invalid',
        ),
        end: exactString(
          satisfaction['end'],
          'Published checkpoint is invalid',
        ),
      }
    default:
      throw new Error('Published checkpoint is invalid')
  }
}

export function projectEvaluationSnapshot(configValue: unknown): {
  readonly snapshot: GoalEvaluationSnapshotV1
  readonly repetition: CalendarRepetitionV1
  readonly checkpointOrder: ReadonlyMap<string, number>
  readonly checklistItemOrder: ReadonlyMap<string, number>
  readonly variantOrder: ReadonlyMap<string, number>
} {
  const config = record(configValue)
  const checkpoints = config['checkpoints']
  const checkpointOrder = new Map<string, number>()
  const checklistItemOrder = new Map<string, number>()
  const variantOrder = new Map<string, number>()
  const measurement = projectMeasurement(config['measurement'])
  if (measurement.kind === 'checklist') {
    measurement.items.forEach((item, index) => {
      checklistItemOrder.set(item.itemId, index)
    })
  }
  if (measurement.kind === 'any_of') {
    measurement.variants.forEach((variant, index) => {
      variantOrder.set(variant.variantId, index)
    })
  }
  let projectedCheckpoints: GoalEvaluationSnapshotV1['checkpoints'] = null
  if (checkpoints !== null) {
    const checkpointConfig = record(checkpoints)
    const items = checkpointConfig['items']
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('Published checkpoints are invalid')
    }
    const projected = items.map((item, index) => {
      const checkpoint = record(item)
      const checkpointId = exactString(
        checkpoint['checkpointId'],
        'Published checkpoints are invalid',
      )
      checkpointOrder.set(checkpointId, index)
      return {
        checkpointId,
        satisfaction: projectCheckpointSatisfaction(checkpoint['satisfaction']),
      }
    }) as [
      {
        readonly checkpointId: string
        readonly satisfaction: EvaluationCheckpointSatisfactionV1
      },
      ...{
        readonly checkpointId: string
        readonly satisfaction: EvaluationCheckpointSatisfactionV1
      }[],
    ]
    projectedCheckpoints = {
      aggregation: exactString(
        checkpointConfig['aggregation'],
        'Published checkpoints are invalid',
      ) as 'independent' | 'all',
      items: projected,
    }
  }
  return {
    snapshot: {
      schemaVersion: 'planner.goal-evaluation-snapshot.v1',
      measurement,
      checkpoints: projectedCheckpoints,
    },
    repetition: projectRepetition(config['repetition']),
    checkpointOrder,
    checklistItemOrder,
    variantOrder,
  }
}

export function projectFactValue(
  rows: readonly ProgressFactRow[],
): GoalFactValueV1 {
  const first = rows[0]
  if (first === undefined) throw new Error('Stored fact group is empty')
  if (first.component_kind === 'checklist_item') {
    const items = rows.map((row) => {
      const itemId = row.checklist_item_id ?? row.component_id
      const state =
        row.fact_kind === 'fixed_not_done'
          ? row.fixed_outcome
          : row.fact_kind === 'checklist_item'
            ? row.checklist_item_state
            : null
      if (itemId === null || (state !== 'done' && state !== 'not_done')) {
        throw new Error('Stored checklist fact group is invalid')
      }
      return { itemId, state }
    })
    return { kind: 'checklist', items }
  }
  if (first.fact_kind === 'quantity_add') {
    const contributions = rows.map((row) => {
      if (
        row.fact_kind !== 'quantity_add' ||
        row.contribution_id === null ||
        row.quantity_value === null
      ) {
        throw new Error('Stored add fact group is invalid')
      }
      return {
        contributionId: row.contribution_id,
        value: row.quantity_value,
      }
    })
    return {
      kind: 'quantity_add',
      contributions: contributions as [
        { readonly contributionId: string; readonly value: string },
        ...{ readonly contributionId: string; readonly value: string }[],
      ],
    }
  }
  if (first.fact_kind === 'checklist_item') {
    const items = rows.map((row) => {
      if (
        row.fact_kind !== 'checklist_item' ||
        row.checklist_item_id === null ||
        row.checklist_item_state === null
      ) {
        throw new Error('Stored checklist fact group is invalid')
      }
      return {
        itemId: row.checklist_item_id,
        state: row.checklist_item_state,
      }
    })
    return { kind: 'checklist', items }
  }
  if (first.fact_kind === 'or_variant') {
    const variants = rows.map((row) => {
      if (
        row.fact_kind !== 'or_variant' ||
        row.or_variant_id === null ||
        row.or_variant_value === null
      ) {
        throw new Error('Stored OR-variant fact group is invalid')
      }
      return {
        variantId: row.or_variant_id,
        value: row.or_variant_value,
      }
    })
    return { kind: 'any_of', variants }
  }
  if (rows.length !== 1) throw new Error('Stored single fact group is invalid')
  switch (first.fact_kind) {
    case 'boolean':
    case 'weekly_task_result':
      if (first.boolean_result === null) {
        throw new Error('Stored Boolean fact is invalid')
      }
      return { kind: 'boolean', result: first.boolean_result }
    case 'quantity_latest':
      if (first.quantity_value === null) {
        throw new Error('Stored quantity fact is invalid')
      }
      return { kind: 'quantity_latest', value: first.quantity_value }
    case 'actual_time':
      if (first.actual_time_value === null) {
        throw new Error('Stored time fact is invalid')
      }
      return { kind: 'actual_time', value: first.actual_time_value }
    case 'rating':
      if (first.rating_value === null) {
        throw new Error('Stored rating fact is invalid')
      }
      return { kind: 'rating', value: storedRating(first.rating_value) }
    case 'text':
      if (first.text_value === null || first.text_result === null) {
        throw new Error('Stored text fact is invalid')
      }
      return {
        kind: 'text',
        text: first.text_value,
        result: first.text_result,
      }
    case 'fixed_not_done':
      if (first.fixed_outcome !== 'not_done') {
        throw new Error('Stored fixed outcome is invalid')
      }
      return { kind: 'not_done' }
    default:
      throw new Error('Stored fact kind is invalid')
  }
}

export class PrismaFactPersistence implements FactPersistencePort {
  public constructor(
    private readonly database: PrismaClientProvider,
    private readonly afterWritePhase: FactWriteObserver = () => undefined,
  ) {}

  public record(input: RecordFactPersistenceInput): Promise<FactRecordRef> {
    return this.database.withClient(async (client) => {
      const target = await this.lockTarget(client, input)
      if (input.localDate > input.currentLocalDate) {
        throw new FactTargetUnavailableError('future_date')
      }
      if (target.status === 'closed') {
        throw new FactTargetUnavailableError('closed')
      }
      if (target.lifecycle_mode === 'reopened') {
        throw new FactTargetUnavailableError('closed')
      }
      if (
        target.active_publication_id !== input.publicationId ||
        !['published', 'grace'].includes(target.status) ||
        input.currentLocalDate < target.active_local_date ||
        input.localDate < target.active_local_date
      ) {
        throw new FactTargetUnavailableError('not_active')
      }
      if (input.checkpointId !== null && target.fixed_expectation_id === null) {
        throw new FactTargetNotFoundError()
      }
      if (
        (input.checklistItemId !== null || input.orVariantId !== null) &&
        target.fixed_expectation_id === null &&
        target.flexible_period_id === null
      ) {
        throw new FactTargetNotFoundError()
      }
      if (
        input.localDate < target.month_start ||
        input.localDate > target.month_end ||
        (target.fixed_expectation_id === null &&
          target.flexible_period_id === null)
      ) {
        throw new FactTargetUnavailableError('not_applicable')
      }
      if (
        target.scope_kind === 'personal' &&
        target.owner_member_id !== input.memberId
      ) {
        throw new TrackingAuthorizationDeniedError()
      }

      const config = record(target.config)
      const measurement = record(config['measurement'])
      const checkpoints = config['checkpoints']
      const repetition = record(config['repetition'])
      if (repetition['kind'] === 'weekly_planned_task') {
        throw new FactTargetUnavailableError('unsupported')
      }
      if (
        target.fixed_expectation_id === null &&
        (input.commandType === 'tracking.record-time.v1' ||
          input.commandType === 'tracking.record-rating.v1' ||
          input.commandType === 'tracking.record-text.v1' ||
          input.commandType === 'tracking.record-checklist-item.v1' ||
          input.commandType === 'tracking.record-or-variant.v1')
      ) {
        throw new FactTargetUnavailableError('unsupported')
      }
      if (
        input.commandType === 'tracking.record-composite-occurrence.v1' &&
        (target.fixed_expectation_id !== null ||
          target.flexible_period_id === null ||
          checkpoints !== null)
      ) {
        throw new FactTargetUnavailableError('unsupported')
      }

      let valueConfig = measurement
      if (input.checkpointId !== null) {
        if (
          target.component_kind !== 'checkpoint' ||
          target.component_id !== input.checkpointId ||
          checkpoints === null ||
          !Array.isArray(record(checkpoints)['items'])
        ) {
          throw new FactTargetNotFoundError()
        }
        const checkpoint = (record(checkpoints)['items'] as unknown[]).find(
          (item) => record(item)['checkpointId'] === input.checkpointId,
        )
        if (checkpoint === undefined) throw new FactTargetNotFoundError()
        valueConfig = record(record(checkpoint)['satisfaction'])
      } else if (
        input.commandType === 'tracking.record-checkpoint.v1' ||
        checkpoints !== null ||
        (target.fixed_expectation_id !== null &&
          input.commandType !== 'tracking.record-checklist-item.v1' &&
          (target.component_kind !== 'goal' || target.component_id !== null))
      ) {
        throw new FactValueInvalidError()
      }

      if (input.commandType === 'tracking.record-checklist-item.v1') {
        const items = measurement['items']
        if (
          input.checklistItemId === null ||
          measurement['kind'] !== 'checklist' ||
          valueConfig['kind'] !== 'checklist' ||
          !Array.isArray(items) ||
          !items.some(
            (item) => record(item)['itemId'] === input.checklistItemId,
          ) ||
          (input.checkpointId === null &&
            (target.component_kind !== 'checklist_item' ||
              target.component_id !== input.checklistItemId))
        ) {
          throw new FactTargetNotFoundError()
        }
      } else if (
        input.commandType === 'tracking.record-composite-occurrence.v1' &&
        input.checklistItemId !== null
      ) {
        const items = measurement['items']
        if (
          measurement['kind'] !== 'checklist' ||
          !Array.isArray(items) ||
          !items.some(
            (item) => record(item)['itemId'] === input.checklistItemId,
          )
        ) {
          throw new FactTargetNotFoundError()
        }
      } else if (input.checklistItemId !== null) {
        throw new FactValueInvalidError()
      }

      let orVariantPrecision: number | null = null
      if (input.orVariantId !== null) {
        const variants: unknown = measurement['variants']
        if (
          valueConfig['kind'] !== 'any_of' ||
          measurement['kind'] !== 'any_of' ||
          !Array.isArray(variants)
        ) {
          throw new FactValueInvalidError()
        }
        const variant = (variants as unknown[]).find(
          (item) => record(item)['variantId'] === input.orVariantId,
        )
        if (variant === undefined) throw new FactTargetNotFoundError()
        const precision = record(variant)['precision']
        if (
          !Number.isInteger(precision) ||
          ![0, 1, 2, 3].includes(precision as number)
        ) {
          throw new FactValueInvalidError()
        }
        orVariantPrecision = precision as number
      }

      let factKind:
        | 'boolean'
        | 'quantity_add'
        | 'quantity_latest'
        | 'actual_time'
        | 'rating'
        | 'text'
        | 'checklist_item'
        | 'or_variant'
      if (valueConfig['kind'] === 'boolean') {
        if (input.value.kind !== 'boolean') throw new FactValueInvalidError()
        factKind = 'boolean'
      } else if (
        valueConfig['kind'] === 'quantity' &&
        input.commandType === 'tracking.record-fact.v1'
      ) {
        if (input.value.kind !== 'quantity') throw new FactValueInvalidError()
        const precision = measurement['precision']
        if (
          !Number.isInteger(precision) ||
          ![0, 1, 2, 3].includes(precision as number) ||
          quantityScale(input.value.value) > (precision as number)
        ) {
          throw new FactValueInvalidError()
        }
        if (measurement['aggregation'] === 'add') factKind = 'quantity_add'
        else if (measurement['aggregation'] === 'latest') {
          factKind = 'quantity_latest'
        } else throw new FactValueInvalidError()
      } else if (valueConfig['kind'] === 'actual_time') {
        if (input.value.kind !== 'actual_time') {
          throw new FactValueInvalidError()
        }
        factKind = 'actual_time'
      } else if (valueConfig['kind'] === 'rating') {
        if (input.value.kind !== 'rating') throw new FactValueInvalidError()
        const minimum = measurement['minimum']
        const maximum = measurement['maximum']
        if (
          !Number.isSafeInteger(minimum) ||
          !Number.isSafeInteger(maximum) ||
          input.value.value < (minimum as number) ||
          input.value.value > (maximum as number)
        ) {
          throw new FactValueInvalidError()
        }
        factKind = 'rating'
      } else if (valueConfig['kind'] === 'text') {
        if (input.value.kind !== 'text') throw new FactValueInvalidError()
        factKind = 'text'
      } else if (valueConfig['kind'] === 'checklist') {
        if (input.value.kind !== 'checklist_item') {
          throw new FactValueInvalidError()
        }
        factKind = 'checklist_item'
      } else if (valueConfig['kind'] === 'any_of') {
        if (
          input.value.kind !== 'or_variant' ||
          input.orVariantId === null ||
          orVariantPrecision === null ||
          quantityScale(input.value.value) > orVariantPrecision
        ) {
          throw new FactValueInvalidError()
        }
        factKind = 'or_variant'
      } else {
        throw new FactValueInvalidError()
      }

      if (
        (input.commandType === 'tracking.record-time.v1' &&
          factKind !== 'actual_time') ||
        (input.commandType === 'tracking.record-rating.v1' &&
          factKind !== 'rating') ||
        (input.commandType === 'tracking.record-text.v1' &&
          factKind !== 'text') ||
        (input.commandType === 'tracking.record-checklist-item.v1' &&
          factKind !== 'checklist_item') ||
        (input.commandType === 'tracking.record-or-variant.v1' &&
          factKind !== 'or_variant') ||
        (input.commandType === 'tracking.record-composite-occurrence.v1' &&
          !['checklist_item', 'or_variant'].includes(factKind)) ||
        (input.commandType === 'tracking.record-fact.v1' &&
          !['boolean', 'quantity_add', 'quantity_latest'].includes(factKind))
      ) {
        throw new FactValueInvalidError()
      }

      const existing =
        factKind === 'quantity_add'
          ? null
          : await this.findCurrentRecord(client, input, target)
      if (existing !== null) {
        throw new FactTargetUnavailableError('correction_required')
      }
      if (input.expectedRevision !== null) {
        throw new FactRevisionConflictError(input.expectedRevision, null)
      }

      const factRecordId = randomUUID()
      const beforeRevisionId = null
      const factRevision = 1n
      const afterRevisionId = randomUUID()
      const contributionId = factKind === 'quantity_add' ? randomUUID() : null
      await client.$executeRaw`
          INSERT INTO tracking_fact_records
            (id, space_id, plan_month_id, publication_id,
             plan_goal_snapshot_id, local_date, fact_kind,
             fixed_expectation_id, flexible_period_id, contribution_id,
             checklist_item_id, or_variant_id,
             current_revision_id, created_by_member_id, created_at, updated_at)
          VALUES
            (${factRecordId}::uuid, ${target.space_id}::uuid,
             ${target.plan_month_id}::uuid, ${input.publicationId}::uuid,
             ${input.planGoalSnapshotId}::uuid, ${input.localDate}::date,
             ${factKind}, ${target.fixed_expectation_id}::uuid,
             ${target.flexible_period_id}::uuid, ${contributionId}::uuid,
             ${input.checklistItemId}::uuid, ${input.orVariantId}::uuid,
             NULL, ${input.memberId}::uuid, ${input.occurredAt},
             ${input.occurredAt})
      `
      await this.afterWritePhase('record')

      const booleanResult =
        input.value.kind === 'boolean' ? input.value.result : null
      const quantityValue =
        input.value.kind === 'quantity' ? input.value.value : null
      const actualTimeValue =
        input.value.kind === 'actual_time' ? input.value.value : null
      const ratingValue =
        input.value.kind === 'rating' ? input.value.value : null
      const textValue = input.value.kind === 'text' ? input.value.text : null
      const textResult = input.value.kind === 'text' ? input.value.result : null
      const checklistItemState =
        input.value.kind === 'checklist_item' ? input.value.state : null
      const orVariantValue =
        input.value.kind === 'or_variant' ? input.value.value : null
      await client.$executeRaw`
        INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, actual_time_value, rating_value,
           text_value, text_result, checklist_item_state,
           or_variant_value,
           recorded_by_member_id, created_at)
        VALUES
          (${afterRevisionId}::uuid, ${factRecordId}::uuid, ${factRevision},
           'recorded', ${booleanResult}, ${quantityValue},
           ${actualTimeValue}::time, ${ratingValue}::bigint,
           ${textValue}, ${textResult}, ${checklistItemState},
           ${orVariantValue},
           ${input.memberId}::uuid, ${input.occurredAt})
      `
      await this.afterWritePhase('revision')
      await client.$executeRaw`
        UPDATE tracking_fact_records
           SET current_revision_id = ${afterRevisionId}::uuid,
               updated_at = ${input.occurredAt}
         WHERE id = ${factRecordId}::uuid
      `
      await this.afterWritePhase('pointer')

      const beforeFactsRevision = target.facts_revision
      const afterFactsRevision = beforeFactsRevision + 1n
      await client.$executeRaw`
        UPDATE plan_months
           SET facts_revision = ${afterFactsRevision}
         WHERE id = ${target.plan_month_id}::uuid
           AND facts_revision = ${beforeFactsRevision}
      `
      await this.afterWritePhase('facts_revision')

      const actionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO tracking_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id, space_id,
           plan_month_id, publication_id, plan_goal_snapshot_id,
           command_type, command_id, before_facts_revision,
           after_facts_revision, occurred_at)
        VALUES
          (${actionId}::uuid, 'fact_recorded', 'member', ${input.actorScope},
           ${input.memberId}::uuid, ${input.spaceId}::uuid,
           ${target.plan_month_id}::uuid, ${input.publicationId}::uuid,
           ${input.planGoalSnapshotId}::uuid, ${input.commandType},
           ${input.commandId}::uuid, ${beforeFactsRevision},
           ${afterFactsRevision}, ${input.occurredAt})
      `
      await client.$executeRaw`
        INSERT INTO tracking_fact_changes
          (action_id, fact_record_id, before_revision_id, after_revision_id)
        VALUES
          (${actionId}::uuid, ${factRecordId}::uuid,
           ${beforeRevisionId}::uuid, ${afterRevisionId}::uuid)
      `
      await this.afterWritePhase('history')
      return { factRecordId, factRevision }
    })
  }

  public mutate(input: MutateFactPersistenceInput): Promise<FactRecordRef> {
    return this.database.withClient(async (client) => {
      const lockedMonth = await client.$queryRaw<{ readonly id: string }[]>`
        SELECT month.id::text
          FROM tracking_fact_records record
          JOIN plan_months month ON month.id = record.plan_month_id
         WHERE record.id = ${input.factRecordId}::uuid
           AND record.space_id = ${input.spaceId}::uuid
         FOR UPDATE OF month
      `
      if (lockedMonth.length === 0) throw new FactTargetNotFoundError()
      await client.$queryRaw<{ readonly id: string }[]>`
        SELECT id::text FROM tracking_fact_records
         WHERE id = ${input.factRecordId}::uuid
           AND space_id = ${input.spaceId}::uuid
         FOR UPDATE
      `
      const rows = await client.$queryRaw<MutationTargetRow[]>`
        SELECT record.id::text, record.fact_kind,
               record.current_revision_id::text,
               revision.revision_number, revision.revision_kind,
               record.plan_month_id::text, month.facts_revision, month.status,
               COALESCE(to_jsonb(month)->>'lifecycle_mode', 'ordinary') lifecycle_mode,
               month.active_publication_id::text,
               record.publication_id::text,
               record.plan_goal_snapshot_id::text,
               publication.active_local_date::text,
               (month.month_start + INTERVAL '1 month + 2 days')::date::text
                 correction_deadline,
               record.space_id::text, snapshot.scope_kind,
               snapshot.owner_member_id::text, snapshot.config,
               record.or_variant_id::text
          FROM tracking_fact_records record
          JOIN tracking_fact_revisions revision
            ON revision.id = record.current_revision_id
          JOIN plan_months month ON month.id = record.plan_month_id
          JOIN plan_publications publication
            ON publication.id = record.publication_id
          JOIN plan_goal_snapshots snapshot
            ON snapshot.id = record.plan_goal_snapshot_id
         WHERE record.id = ${input.factRecordId}::uuid
           AND record.space_id = ${input.spaceId}::uuid
      `
      const target = rows[0]
      if (target === undefined) throw new FactTargetNotFoundError()
      if (target.fact_kind === 'fixed_not_done') {
        throw new FactTargetUnavailableError('unsupported')
      }
      if (
        target.status === 'closed' ||
        (target.lifecycle_mode !== 'reopened' &&
          input.currentLocalDate > target.correction_deadline)
      ) {
        throw new FactTargetUnavailableError('closed')
      }
      if (
        target.active_publication_id !== target.publication_id ||
        !['published', 'grace'].includes(target.status) ||
        input.currentLocalDate < target.active_local_date
      ) {
        throw new FactTargetUnavailableError('not_active')
      }
      if (
        target.scope_kind === 'personal' &&
        target.owner_member_id !== input.memberId
      ) {
        throw new TrackingAuthorizationDeniedError()
      }
      if (
        input.commandType === 'tracking.delete-record.v1' &&
        target.scope_kind !== 'personal'
      ) {
        throw new TrackingAuthorizationDeniedError()
      }
      if (
        input.commandType === 'tracking.delete-record.v1' &&
        target.revision_kind === 'tombstoned'
      ) {
        throw new FactTargetUnavailableError('already_deleted')
      }
      if (target.revision_number !== input.expectedRevision) {
        throw new FactRevisionConflictError(
          input.expectedRevision,
          target.revision_number,
        )
      }
      if (
        (input.commandType === 'tracking.correct-record.v1' &&
          input.value === null) ||
        (input.commandType === 'tracking.delete-record.v1' &&
          input.value !== null)
      ) {
        throw new FactValueInvalidError()
      }
      assertMutationValue(target, input.value)

      const afterRevisionId = randomUUID()
      const factRevision = target.revision_number + 1n
      const booleanResult =
        input.value?.kind === 'boolean' ? input.value.result : null
      const quantityValue =
        input.value?.kind === 'quantity' ? input.value.value : null
      const actualTimeValue =
        input.value?.kind === 'actual_time' ? input.value.value : null
      const ratingValue =
        input.value?.kind === 'rating' ? input.value.value : null
      const textValue = input.value?.kind === 'text' ? input.value.text : null
      const textResult =
        input.value?.kind === 'text' ? input.value.result : null
      const checklistItemState =
        input.value?.kind === 'checklist_item' ? input.value.state : null
      const orVariantValue =
        input.value?.kind === 'or_variant' ? input.value.value : null
      const revisionKind = input.value === null ? 'tombstoned' : 'recorded'
      await client.$executeRaw`
        INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, actual_time_value, rating_value,
           text_value, text_result, checklist_item_state, or_variant_value,
           recorded_by_member_id, created_at)
        VALUES
          (${afterRevisionId}::uuid, ${target.id}::uuid, ${factRevision},
           ${revisionKind}, ${booleanResult}, ${quantityValue},
           ${actualTimeValue}::time, ${ratingValue}::bigint,
           ${textValue}, ${textResult}, ${checklistItemState},
           ${orVariantValue}, ${input.memberId}::uuid, ${input.occurredAt})
      `
      await this.afterWritePhase('revision')
      await client.$executeRaw`
        UPDATE tracking_fact_records
           SET current_revision_id = ${afterRevisionId}::uuid,
               updated_at = ${input.occurredAt}
         WHERE id = ${target.id}::uuid
      `
      await this.afterWritePhase('pointer')

      const afterFactsRevision = target.facts_revision + 1n
      await client.$executeRaw`
        UPDATE plan_months
           SET facts_revision = ${afterFactsRevision}
         WHERE id = ${target.plan_month_id}::uuid
           AND facts_revision = ${target.facts_revision}
      `
      await this.afterWritePhase('facts_revision')

      const actionId = randomUUID()
      const actionKind =
        input.commandType === 'tracking.correct-record.v1'
          ? 'fact_corrected'
          : 'fact_tombstoned'
      await client.$executeRaw`
        INSERT INTO tracking_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id, space_id,
           plan_month_id, publication_id, plan_goal_snapshot_id,
           command_type, command_id, before_facts_revision,
           after_facts_revision, reason, occurred_at)
        VALUES
          (${actionId}::uuid, ${actionKind}, 'member', ${input.actorScope},
           ${input.memberId}::uuid, ${input.spaceId}::uuid,
           ${target.plan_month_id}::uuid, ${target.publication_id}::uuid,
           ${target.plan_goal_snapshot_id}::uuid, ${input.commandType},
           ${input.commandId}::uuid, ${target.facts_revision},
           ${afterFactsRevision}, ${input.reason}, ${input.occurredAt})
      `
      await client.$executeRaw`
        INSERT INTO tracking_fact_changes
          (action_id, fact_record_id, before_revision_id, after_revision_id)
        VALUES
          (${actionId}::uuid, ${target.id}::uuid,
           ${target.current_revision_id}::uuid, ${afterRevisionId}::uuid)
      `
      await this.afterWritePhase('history')
      return { factRecordId: target.id, factRevision }
    })
  }

  public undoLastOwnAction(
    input: UndoLastOwnActionPersistenceInput,
  ): Promise<FactRecordRef> {
    return this.database.withClient(async (client) => {
      const lockedMonth = await client.$queryRaw<{ readonly id: string }[]>`
        SELECT month.id::text
          FROM tracking_fact_records record
          JOIN plan_months month ON month.id = record.plan_month_id
         WHERE record.id = ${input.factRecordId}::uuid
           AND record.space_id = ${input.spaceId}::uuid
         FOR UPDATE OF month
      `
      if (lockedMonth.length === 0) throw new FactTargetNotFoundError()
      await client.$queryRaw<{ readonly id: string }[]>`
        SELECT id::text FROM tracking_fact_records
         WHERE id = ${input.factRecordId}::uuid
           AND space_id = ${input.spaceId}::uuid
         FOR UPDATE
      `
      const targetRows = await client.$queryRaw<UndoTargetRow[]>`
        SELECT record.id::text, record.fact_kind,
               record.current_revision_id::text,
               revision.revision_number, record.plan_month_id::text,
               month.facts_revision, month.status,
               COALESCE(to_jsonb(month)->>'lifecycle_mode', 'ordinary') lifecycle_mode,
               month.active_publication_id::text,
               record.publication_id::text,
               record.plan_goal_snapshot_id::text,
               publication.active_local_date::text,
               (month.month_start + INTERVAL '1 month + 2 days')::date::text
                 correction_deadline,
               record.space_id::text
          FROM tracking_fact_records record
          JOIN tracking_fact_revisions revision
            ON revision.id = record.current_revision_id
          JOIN plan_months month ON month.id = record.plan_month_id
          JOIN plan_publications publication
            ON publication.id = record.publication_id
         WHERE record.id = ${input.factRecordId}::uuid
           AND record.space_id = ${input.spaceId}::uuid
      `
      const target = targetRows[0]
      if (target === undefined) throw new FactTargetNotFoundError()
      if (target.fact_kind === 'fixed_not_done') {
        throw new FactTargetUnavailableError('unsupported')
      }
      if (
        target.status === 'closed' ||
        target.lifecycle_mode === 'reopened' ||
        input.currentLocalDate > target.correction_deadline
      ) {
        throw new FactTargetUnavailableError('closed')
      }
      if (
        target.active_publication_id !== target.publication_id ||
        !['published', 'grace'].includes(target.status) ||
        input.currentLocalDate < target.active_local_date
      ) {
        throw new FactTargetUnavailableError('not_active')
      }
      if (target.revision_number !== input.expectedRevision) {
        throw new FactRevisionConflictError(
          input.expectedRevision,
          target.revision_number,
        )
      }

      const candidates = await client.$queryRaw<UndoCandidateRow[]>`
        SELECT action.id::text action_id,
               change.fact_record_id::text,
               change.before_revision_id::text,
               change.after_revision_id::text,
               source.revision_kind source_revision_kind,
               source.boolean_result, source.quantity_value,
               to_char(source.actual_time_value, 'HH24:MI') actual_time_value,
               source.rating_value, source.text_value, source.text_result,
               source.checklist_item_state, source.or_variant_value
          FROM tracking_action_groups action
          JOIN tracking_fact_changes change ON change.action_id = action.id
          LEFT JOIN tracking_fact_undo_changes compensated
            ON compensated.undone_action_id = action.id
          LEFT JOIN tracking_fact_revisions source
            ON source.id = change.before_revision_id
         WHERE action.plan_month_id = ${target.plan_month_id}::uuid
           AND action.actor_kind = 'member'
           AND action.member_id = ${input.memberId}::uuid
           AND action.action_kind IN (
             'fact_recorded', 'fact_corrected', 'fact_tombstoned'
           )
           AND compensated.action_id IS NULL
         ORDER BY action.after_facts_revision DESC
         LIMIT 1
      `
      const candidate = candidates[0]
      if (candidate === undefined) {
        throw new FactUndoUnavailableError('nothing_to_undo')
      }
      if (candidate.fact_record_id !== target.id) {
        throw new FactUndoUnavailableError('not_latest')
      }
      const provenance = await client.$queryRaw<{ readonly valid: boolean }[]>`
        WITH RECURSIVE effective_revision(revision_id) AS (
          SELECT ${target.current_revision_id}::uuid
          UNION
          SELECT undo.restored_from_revision_id
            FROM effective_revision current_state
            JOIN tracking_fact_changes current_change
              ON current_change.after_revision_id = current_state.revision_id
             AND current_change.fact_record_id = ${target.id}::uuid
            JOIN tracking_action_groups current_action
              ON current_action.id = current_change.action_id
            JOIN tracking_fact_undo_changes undo
              ON undo.action_id = current_action.id
           WHERE current_action.action_kind = 'fact_undone'
             AND current_action.actor_kind = 'member'
             AND current_action.member_id = ${input.memberId}::uuid
             AND undo.restored_from_revision_id IS NOT NULL
        )
        SELECT EXISTS (
          SELECT 1 FROM effective_revision
           WHERE revision_id = ${candidate.after_revision_id}::uuid
        ) valid
      `
      if (provenance[0]?.valid !== true) {
        throw new FactUndoUnavailableError('superseded')
      }

      const afterRevisionId = randomUUID()
      const factRevision = target.revision_number + 1n
      const revisionKind =
        candidate.before_revision_id === null
          ? 'tombstoned'
          : candidate.source_revision_kind
      if (revisionKind === null) {
        throw new Error('Undo source revision is missing')
      }
      await client.$executeRaw`
        INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, actual_time_value, rating_value,
           text_value, text_result, checklist_item_state, or_variant_value,
           recorded_by_member_id, created_at)
        VALUES
          (${afterRevisionId}::uuid, ${target.id}::uuid, ${factRevision},
           ${revisionKind}, ${candidate.boolean_result},
           ${candidate.quantity_value}, ${candidate.actual_time_value}::time,
           ${candidate.rating_value}::bigint, ${candidate.text_value},
           ${candidate.text_result}, ${candidate.checklist_item_state},
           ${candidate.or_variant_value}, ${input.memberId}::uuid,
           ${input.occurredAt})
      `
      await this.afterWritePhase('revision')
      await client.$executeRaw`
        UPDATE tracking_fact_records
           SET current_revision_id = ${afterRevisionId}::uuid,
               updated_at = ${input.occurredAt}
         WHERE id = ${target.id}::uuid
      `
      await this.afterWritePhase('pointer')

      const afterFactsRevision = target.facts_revision + 1n
      await client.$executeRaw`
        UPDATE plan_months
           SET facts_revision = ${afterFactsRevision}
         WHERE id = ${target.plan_month_id}::uuid
           AND facts_revision = ${target.facts_revision}
      `
      await this.afterWritePhase('facts_revision')

      const actionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO tracking_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id, space_id,
           plan_month_id, publication_id, plan_goal_snapshot_id,
           command_type, command_id, before_facts_revision,
           after_facts_revision, reason, occurred_at)
        VALUES
          (${actionId}::uuid, 'fact_undone', 'member', ${input.actorScope},
           ${input.memberId}::uuid, ${input.spaceId}::uuid,
           ${target.plan_month_id}::uuid, ${target.publication_id}::uuid,
           ${target.plan_goal_snapshot_id}::uuid,
           'tracking.undo-last-own-action.v1', ${input.commandId}::uuid,
           ${target.facts_revision}, ${afterFactsRevision}, NULL,
           ${input.occurredAt})
      `
      await client.$executeRaw`
        INSERT INTO tracking_fact_changes
          (action_id, fact_record_id, before_revision_id, after_revision_id)
        VALUES
          (${actionId}::uuid, ${target.id}::uuid,
           ${target.current_revision_id}::uuid, ${afterRevisionId}::uuid)
      `
      await this.afterWritePhase('history')
      await client.$executeRaw`
        INSERT INTO tracking_fact_undo_changes
          (action_id, undone_action_id, restored_from_revision_id)
        VALUES
          (${actionId}::uuid, ${candidate.action_id}::uuid,
           ${candidate.before_revision_id}::uuid)
      `
      await this.afterWritePhase('undo_detail')
      return { factRecordId: target.id, factRevision }
    })
  }

  public getState(
    input: GetFactStatePersistenceInput,
  ): Promise<FactStateV1 | null> {
    return this.database.withClient(async (client) => {
      const header = await client.$queryRaw<
        { readonly facts_revision: bigint }[]
      >`
        SELECT month.facts_revision
          FROM plan_publications publication
          JOIN plan_months month ON month.id = publication.plan_month_id
          JOIN plan_goal_snapshots snapshot
            ON snapshot.publication_id = publication.id
           AND snapshot.id = ${input.planGoalSnapshotId}::uuid
         WHERE publication.id = ${input.publicationId}::uuid
           AND publication.space_id = ${input.spaceId}::uuid
      `
      if (header.length === 0) return null
      const rows = await client.$queryRaw<StateRow[]>`
        SELECT record.id::text fact_record_id, record.fact_kind,
               record.contribution_id::text,
               record.checklist_item_id::text,
               record.or_variant_id::text,
               revision.revision_number,
               revision.revision_kind, revision.boolean_result,
               revision.quantity_value,
               to_char(revision.actual_time_value, 'HH24:MI') actual_time_value,
               revision.rating_value::text rating_value,
               revision.text_value, revision.text_result,
               revision.checklist_item_state,
               revision.or_variant_value,
               revision.fixed_outcome,
               revision.recorded_by_member_id::text,
               revision.recorded_by_system_actor_id
          FROM tracking_fact_records record
          JOIN tracking_fact_revisions revision
            ON revision.id = record.current_revision_id
          JOIN tracking_fact_changes fact_change
            ON fact_change.after_revision_id = revision.id
          JOIN tracking_action_groups action
            ON action.id = fact_change.action_id
         WHERE record.publication_id = ${input.publicationId}::uuid
           AND record.plan_goal_snapshot_id = ${input.planGoalSnapshotId}::uuid
           AND record.local_date = ${input.localDate}::date
           AND revision.revision_kind = 'recorded'
           AND (
             record.fact_kind <> 'fixed_not_done'
             OR NOT EXISTS (
               SELECT 1
                 FROM tracking_fact_records typed_record
                 JOIN tracking_fact_revisions typed_revision
                   ON typed_revision.id = typed_record.current_revision_id
                WHERE typed_record.fixed_expectation_id =
                      record.fixed_expectation_id
                  AND typed_record.fact_kind <> 'fixed_not_done'
                  AND typed_revision.revision_kind = 'recorded'
             )
           )
           AND (
             record.fixed_expectation_id IS NULL
             OR EXISTS (
               SELECT 1 FROM fixed_expectations expectation
                WHERE expectation.id = record.fixed_expectation_id
                  AND expectation.component_kind = 'goal'
                  AND expectation.component_id IS NULL
             )
           )
         ORDER BY action.after_facts_revision, record.id
      `
      let fact: FactValueStateV1 | null = null
      const first = rows[0]
      if (first?.fact_kind === 'quantity_add') {
        const contributions: QuantityAddContributionV1[] = rows.map((row) => {
          if (
            row.fact_kind !== 'quantity_add' ||
            row.contribution_id === null ||
            row.quantity_value === null
          ) {
            throw new Error('Stored add fact state is invalid')
          }
          return {
            contributionId: row.contribution_id,
            factRecordId: row.fact_record_id,
            revision: row.revision_number,
            value: row.quantity_value,
            recordedByMemberId: memberRecorder(row),
          }
        })
        fact = { kind: 'quantity_add', contributions }
      } else if (first?.fact_kind === 'quantity_latest') {
        if (first.quantity_value === null || rows.length !== 1) {
          throw new Error('Stored latest fact state is invalid')
        }
        fact = {
          kind: 'quantity_latest',
          factRecordId: first.fact_record_id,
          revision: first.revision_number,
          value: first.quantity_value,
          recordedByMemberId: memberRecorder(first),
        }
      } else if (first?.fact_kind === 'boolean') {
        if (first.boolean_result === null || rows.length !== 1) {
          throw new Error('Stored Boolean fact state is invalid')
        }
        fact = {
          kind: 'boolean',
          factRecordId: first.fact_record_id,
          revision: first.revision_number,
          result: first.boolean_result,
          recordedByMemberId: memberRecorder(first),
        }
      } else if (first?.fact_kind === 'actual_time') {
        if (first.actual_time_value === null || rows.length !== 1) {
          throw new Error('Stored time fact state is invalid')
        }
        fact = {
          kind: 'actual_time',
          factRecordId: first.fact_record_id,
          revision: first.revision_number,
          value: first.actual_time_value,
          recordedByMemberId: memberRecorder(first),
        }
      } else if (first?.fact_kind === 'rating') {
        if (first.rating_value === null || rows.length !== 1) {
          throw new Error('Stored rating fact state is invalid')
        }
        fact = {
          kind: 'rating',
          factRecordId: first.fact_record_id,
          revision: first.revision_number,
          value: storedRating(first.rating_value),
          recordedByMemberId: memberRecorder(first),
        }
      } else if (first?.fact_kind === 'text') {
        if (
          first.text_value === null ||
          first.text_result === null ||
          rows.length !== 1
        ) {
          throw new Error('Stored text fact state is invalid')
        }
        fact = {
          kind: 'text',
          factRecordId: first.fact_record_id,
          revision: first.revision_number,
          text: first.text_value,
          result: first.text_result,
          recordedByMemberId: memberRecorder(first),
        }
      } else if (first?.fact_kind === 'fixed_not_done') {
        if (first.fixed_outcome !== 'not_done' || rows.length !== 1) {
          throw new Error('Stored fixed not_done state is invalid')
        }
        fact = {
          kind: 'fixed_not_done',
          factRecordId: first.fact_record_id,
          revision: first.revision_number,
          result: 'not_done',
          recordedByMemberId: memberRecorder(first),
        }
      }
      return freeze({
        publicationId: input.publicationId,
        planGoalSnapshotId: input.planGoalSnapshotId,
        localDate: input.localDate,
        factsRevision: header[0]!.facts_revision,
        fact,
      })
    })
  }

  public getGoalProgressInput(
    input: GetGoalProgressPersistenceInput,
  ): Promise<EvaluateGoalProgressInput | null> {
    return this.database.withClient(async (client) => {
      const headers = await client.$queryRaw<ProgressHeaderRow[]>`
        SELECT to_char(month.month_start, 'YYYY-MM') target_month,
               publication.active_local_date::text,
               publication.calendar_formula_version,
               publication.evaluation_formula_version,
               snapshot.config, snapshot.calendar
          FROM plan_publications publication
          JOIN plan_months month ON month.id = publication.plan_month_id
          JOIN plan_goal_snapshots snapshot
            ON snapshot.publication_id = publication.id
           AND snapshot.id = ${input.planGoalSnapshotId}::uuid
         WHERE publication.id = ${input.publicationId}::uuid
           AND publication.space_id = ${input.spaceId}::uuid
      `
      const header = headers[0]
      if (header === undefined) return null
      const rows = await client.$queryRaw<ProgressFactRow[]>`
        SELECT record.id::text fact_record_id, record.fact_kind,
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
               period.period_start::text, period.period_end::text
          FROM tracking_fact_records record
          JOIN tracking_fact_revisions revision
            ON revision.id = record.current_revision_id
          LEFT JOIN fixed_expectations expectation
            ON expectation.id = record.fixed_expectation_id
          LEFT JOIN flexible_periods period
            ON period.id = record.flexible_period_id
         WHERE record.publication_id = ${input.publicationId}::uuid
           AND record.plan_goal_snapshot_id = ${input.planGoalSnapshotId}::uuid
           AND record.local_date <= ${input.asOfLocalDate}::date
           AND revision.revision_kind = 'recorded'
           AND (
             record.fact_kind <> 'fixed_not_done'
             OR NOT EXISTS (
               SELECT 1
                 FROM tracking_fact_records typed_record
                 JOIN tracking_fact_revisions typed_revision
                   ON typed_revision.id = typed_record.current_revision_id
                WHERE typed_record.fixed_expectation_id =
                      record.fixed_expectation_id
                  AND typed_record.fact_kind <> 'fixed_not_done'
                  AND typed_revision.revision_kind = 'recorded'
             )
           )
         ORDER BY record.local_date, expectation.component_kind,
                  expectation.component_id, record.created_at, record.id
      `
      try {
        if (
          header.calendar_formula_version !== 'planner.calendar-targets.v1' ||
          header.evaluation_formula_version !== 'planner.goal-evaluation.v1'
        ) {
          throw new Error('Published formula versions are unsupported')
        }
        const projected = projectEvaluationSnapshot(header.config)
        const groups = new Map<string, ProgressFactRow[]>()
        for (const row of rows) {
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
            const values = checkpointsByDate.get(first.local_date)
            const checkpoint = { checkpointId: first.component_id, value }
            if (values === undefined) {
              checkpointsByDate.set(first.local_date, [checkpoint])
            } else values.push(checkpoint)
          } else if (first.fixed_expectation_id !== null) {
            if (
              first.component_kind !== 'checklist_item' &&
              (first.component_kind !== 'goal' || first.component_id !== null)
            ) {
              throw new Error('Stored fixed fact identity is invalid')
            }
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
          facts.push({
            kind: 'fixed_checkpoints',
            expectationDate,
            checkpoints,
          })
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
            leftDate.localeCompare(rightDate) ||
            left.kind.localeCompare(right.kind)
          )
        })

        return freeze({
          snapshot: projected.snapshot,
          calendarInput: {
            targetMonth: header.target_month,
            activeLocalDate: header.active_local_date,
            timeZone: 'Asia/Yekaterinburg',
            repetition: projected.repetition,
          },
          calendar: {
            formulaVersion: 'planner.calendar-targets.v1',
            eligible: true,
            calendar: header.calendar,
            issues: [],
          } as SuccessfulEligibleCalendarResult,
          facts,
          asOfLocalDate: input.asOfLocalDate,
        })
      } catch (error: unknown) {
        if (error instanceof TrackingProgressSourceInvalidError) throw error
        throw new TrackingProgressSourceInvalidError({ cause: error })
      }
    })
  }

  private async lockTarget(
    client: Client,
    input: RecordFactPersistenceInput,
  ): Promise<TargetRow> {
    const rows = await client.$queryRaw<TargetRow[]>`
      SELECT month.id::text plan_month_id, month.facts_revision, month.status,
             COALESCE(to_jsonb(month)->>'lifecycle_mode', 'ordinary') lifecycle_mode,
             month.active_publication_id::text,
             month.month_start::text,
             (month.month_start + INTERVAL '1 month - 1 day')::date::text month_end,
             publication.active_local_date::text,
             publication.space_id::text space_id,
             snapshot.scope_kind, snapshot.owner_member_id::text,
             snapshot.config,
             expectation.id::text fixed_expectation_id,
             period.id::text flexible_period_id,
             expectation.component_kind,
             expectation.component_id::text
        FROM plan_publications publication
        JOIN plan_months month ON month.id = publication.plan_month_id
        JOIN plan_goal_snapshots snapshot
          ON snapshot.publication_id = publication.id
         AND snapshot.id = ${input.planGoalSnapshotId}::uuid
        LEFT JOIN fixed_expectations expectation
          ON expectation.publication_id = snapshot.publication_id
         AND expectation.plan_goal_snapshot_id = snapshot.id
         AND ${input.commandType} <> 'tracking.record-composite-occurrence.v1'
         AND expectation.expectation_date = ${input.localDate}::date
         AND expectation.component_kind =
           CASE
             WHEN ${input.checkpointId}::uuid IS NOT NULL THEN 'checkpoint'
             WHEN ${input.checklistItemId}::uuid IS NOT NULL
               THEN 'checklist_item'
             ELSE 'goal'
           END
         AND expectation.component_id IS NOT DISTINCT FROM
           COALESCE(
             ${input.checkpointId}::uuid,
             ${input.checklistItemId}::uuid
           )
        LEFT JOIN LATERAL (
          SELECT candidate.id
            FROM flexible_periods candidate
           WHERE candidate.publication_id = snapshot.publication_id
             AND candidate.plan_goal_snapshot_id = snapshot.id
             AND ${input.checkpointId}::uuid IS NULL
             AND candidate.period_target > 0
             AND ${input.localDate}::date = ANY(candidate.eligible_dates)
           ORDER BY candidate.ordinal, candidate.id
           LIMIT 1
        ) period ON TRUE
       WHERE publication.id = ${input.publicationId}::uuid
         AND publication.space_id = ${input.spaceId}::uuid
       FOR UPDATE OF month
    `
    const target = rows[0]
    if (target === undefined) throw new FactTargetNotFoundError()
    return target
  }

  private async findCurrentRecord(
    client: Client,
    input: RecordFactPersistenceInput,
    target: TargetRow,
  ): Promise<CurrentRecordRow | null> {
    const rows = await client.$queryRaw<CurrentRecordRow[]>`
      SELECT record.id::text, record.current_revision_id::text,
             revision.revision_number
        FROM tracking_fact_records record
        LEFT JOIN tracking_fact_revisions revision
          ON revision.id = record.current_revision_id
       WHERE record.publication_id = ${input.publicationId}::uuid
         AND record.plan_goal_snapshot_id = ${input.planGoalSnapshotId}::uuid
         AND record.local_date = ${input.localDate}::date
         AND record.fixed_expectation_id IS NOT DISTINCT FROM
           ${target.fixed_expectation_id}::uuid
         AND record.flexible_period_id IS NOT DISTINCT FROM
           ${target.flexible_period_id}::uuid
         AND record.checklist_item_id IS NOT DISTINCT FROM
           ${input.checklistItemId}::uuid
         AND record.or_variant_id IS NOT DISTINCT FROM
           ${input.orVariantId}::uuid
         AND record.fact_kind IN (
           'boolean', 'quantity_latest', 'actual_time', 'rating',
           'text', 'checklist_item', 'or_variant'
         )
    `
    return rows[0] ?? null
  }
}
