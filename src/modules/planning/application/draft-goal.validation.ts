import { createHash } from 'node:crypto'

import type { CanonicalJsonObject } from '@/shared/application/application-command'
import { CommandValidationError } from '@/shared/application/application-command'

import {
  DraftGoalConfigValidationError,
  snapshotDraftGoalConfig,
  snapshotSourceProvenance,
  type DraftGoalConfigV1,
} from '../domain/goal-config'
import { isCanonicalPlanningUuid } from '../domain/planning-values'
import type {
  AddDraftGoalApplicationCommand,
  AddDraftGoalPayload,
  GetDraftEditorInput,
  RemoveDraftGoalApplicationCommand,
  RemoveDraftGoalPayload,
  ReorderDraftGoalsApplicationCommand,
  ReorderDraftGoalsPayload,
  UpdateDraftGoalApplicationCommand,
  UpdateDraftGoalPayload,
} from './draft-goal.types'
import { validateTargetMonth } from './planning-command.validation'

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CommandValidationError()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some(
      (key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        descriptors[key]?.get !== undefined ||
        descriptors[key]?.set !== undefined,
    )
  ) {
    throw new CommandValidationError()
  }
  return value as Record<string, unknown>
}

function exactArray(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    throw new CommandValidationError()
  }
  const keys = Reflect.ownKeys(value)
  const expected = Array.from({ length: value.length }, (_, index) =>
    String(index),
  )
  expected.push('length')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key)) ||
    expected.some((key) => {
      const descriptor = descriptors[key]
      return (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !('value' in descriptor)
      )
    })
  ) {
    throw new CommandValidationError()
  }
  return value
}

function uuid(value: unknown): string {
  if (!isCanonicalPlanningUuid(value)) throw new CommandValidationError()
  return value
}

function deterministicUuid(commandId: string, index: number): string {
  const hex = createHash('sha256')
    .update(`planner:p03:${commandId}:${index}`)
    .digest('hex')
    .slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`
}

export function isGeneratedDraftGoalChildId(
  commandId: string,
  value: string,
): boolean {
  for (let index = 0; index < 300; index += 1) {
    if (deterministicUuid(commandId, index) === value) return true
  }
  return false
}

function snapshotActor(
  value: unknown,
):
  | { readonly kind: 'member'; readonly id: string }
  | { readonly kind: 'system'; readonly id: 'planner-worker' } {
  const actor = exact(value, ['kind', 'id'])
  if (actor.kind === 'member')
    return Object.freeze({ kind: 'member', id: uuid(actor.id) })
  if (actor.kind === 'system' && actor.id === 'planner-worker') {
    return Object.freeze({ kind: 'system', id: 'planner-worker' })
  }
  throw new CommandValidationError()
}

function command(value: unknown): {
  readonly commandId: string
  readonly trustedActor: ReturnType<typeof snapshotActor>
  readonly expectedRevision: bigint
  readonly payload: unknown
} {
  const record = exact(value, [
    'commandId',
    'trustedActor',
    'expectedRevision',
    'payload',
  ])
  const expectedRevision = record.expectedRevision
  if (typeof expectedRevision !== 'bigint' || expectedRevision <= 0n) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    commandId: uuid(record.commandId),
    trustedActor: snapshotActor(record.trustedActor),
    expectedRevision,
    payload: record.payload,
  })
}

function goalConfig(
  value: unknown,
  commandId: string,
  mode: 'add' | 'update',
  previousConfig?: DraftGoalConfigV1,
): DraftGoalConfigV1 {
  let index = 0
  return asCommandValidation(() =>
    snapshotDraftGoalConfig(value, {
      mode: mode === 'update' && previousConfig === undefined ? 'stored' : mode,
      ...(previousConfig === undefined ? {} : { previousConfig }),
      generateId: () => deterministicUuid(commandId, index++),
    }),
  )
}

function asCommandValidation<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error: unknown) {
    if (error instanceof DraftGoalConfigValidationError) {
      throw new CommandValidationError()
    }
    throw error
  }
}

export function snapshotAddDraftGoalCommand(
  value: unknown,
): AddDraftGoalApplicationCommand {
  const base = command(value)
  const payload = exact(base.payload, [
    'planMonthId',
    'goalDefinitionId',
    'config',
    'sourceProvenance',
  ])
  return Object.freeze({
    ...base,
    payload: Object.freeze({
      planMonthId: uuid(payload.planMonthId),
      goalDefinitionId: uuid(payload.goalDefinitionId),
      config: goalConfig(payload.config, base.commandId, 'add'),
      sourceProvenance: asCommandValidation(() =>
        snapshotSourceProvenance(payload.sourceProvenance),
      ),
    }),
  })
}

export function snapshotUpdateDraftGoalCommand(
  value: unknown,
  previousConfig?: DraftGoalConfigV1,
): UpdateDraftGoalApplicationCommand {
  const base = command(value)
  const payload = exact(base.payload, [
    'planMonthId',
    'planGoalId',
    'goalDefinitionVersionId',
    'config',
    'sourceProvenance',
  ])
  return Object.freeze({
    ...base,
    payload: Object.freeze({
      planMonthId: uuid(payload.planMonthId),
      planGoalId: uuid(payload.planGoalId),
      goalDefinitionVersionId: uuid(payload.goalDefinitionVersionId),
      config: goalConfig(
        payload.config,
        base.commandId,
        'update',
        previousConfig,
      ),
      sourceProvenance: asCommandValidation(() =>
        snapshotSourceProvenance(payload.sourceProvenance),
      ),
    }),
  })
}

export function snapshotRemoveDraftGoalCommand(
  value: unknown,
): RemoveDraftGoalApplicationCommand {
  const base = command(value)
  const payload = exact(base.payload, ['planMonthId', 'planGoalId'])
  return Object.freeze({
    ...base,
    payload: Object.freeze({
      planMonthId: uuid(payload.planMonthId),
      planGoalId: uuid(payload.planGoalId),
    }),
  })
}

export function snapshotReorderDraftGoalsCommand(
  value: unknown,
): ReorderDraftGoalsApplicationCommand {
  const base = command(value)
  const payload = exact(base.payload, ['planMonthId', 'orderedPlanGoalIds'])
  const ids = exactArray(payload.orderedPlanGoalIds, 200).map(uuid)
  return Object.freeze({
    ...base,
    payload: Object.freeze({
      planMonthId: uuid(payload.planMonthId),
      orderedPlanGoalIds: Object.freeze(ids),
    }),
  })
}

export function snapshotGetDraftEditorInput(
  value: unknown,
): GetDraftEditorInput {
  const input = exact(value, ['trustedActor', 'targetMonth'])
  return Object.freeze({
    trustedActor: snapshotActor(input.trustedActor),
    targetMonth: validateTargetMonth(input.targetMonth),
  })
}

export function canonicalAddDraftGoalPayload(
  payload: AddDraftGoalPayload,
): CanonicalJsonObject {
  return payload
}
export function canonicalUpdateDraftGoalPayload(
  payload: UpdateDraftGoalPayload,
): CanonicalJsonObject {
  return payload
}
export function canonicalRemoveDraftGoalPayload(
  payload: RemoveDraftGoalPayload,
): CanonicalJsonObject {
  return payload
}
export function canonicalReorderDraftGoalsPayload(
  payload: ReorderDraftGoalsPayload,
): CanonicalJsonObject {
  return payload
}
