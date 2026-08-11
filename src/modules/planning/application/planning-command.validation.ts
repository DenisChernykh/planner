import type {
  ActorRef,
  CanonicalJsonObject,
} from '@/shared/application/application-command'
import { CommandValidationError } from '@/shared/application/application-command'

import {
  isCanonicalCalendarMonth,
  isCanonicalPlanningUuid,
  isValidMonthFocus,
} from '../domain/planning-values'
import type {
  CreateEmptyDraftApplicationCommand,
  CreateEmptyDraftPayload,
  UpdateMonthFocusApplicationCommand,
  UpdateMonthFocusPayload,
} from './planning.types'

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false
  }
  const ownKeys = Reflect.ownKeys(value)
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
  )
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function snapshotActor(value: unknown): ActorRef {
  if (!exactObject(value, ['kind', 'id'])) {
    throw new CommandValidationError()
  }
  const kind = value.kind
  const id = value.id
  if (kind === 'member' && isCanonicalPlanningUuid(id)) {
    return Object.freeze({ kind, id })
  }
  if (kind === 'system' && id === 'planner-worker') {
    return Object.freeze({ kind, id })
  }
  throw new CommandValidationError()
}

function snapshotCommandId(value: unknown): string {
  if (!isCanonicalPlanningUuid(value)) throw new CommandValidationError()
  return value
}

function snapshotCreatePayload(value: unknown): CreateEmptyDraftPayload {
  if (!exactObject(value, ['targetMonth', 'focus'])) {
    throw new CommandValidationError()
  }
  const targetMonth = validateTargetMonth(value.targetMonth)
  const focus = validateFocus(value.focus)
  return Object.freeze({ targetMonth, focus })
}

function snapshotUpdatePayload(value: unknown): UpdateMonthFocusPayload {
  if (!exactObject(value, ['planMonthId', 'focus'])) {
    throw new CommandValidationError()
  }
  const planMonthId = validatePlanMonthId(value.planMonthId)
  const focus = validateFocus(value.focus)
  return Object.freeze({ planMonthId, focus })
}

export function validateTargetMonth(value: unknown): string {
  if (!isCanonicalCalendarMonth(value)) throw new CommandValidationError()
  return value
}

export function validateFocus(value: unknown): string {
  if (!isValidMonthFocus(value)) throw new CommandValidationError()
  return value
}

export function validatePlanMonthId(value: unknown): string {
  if (!isCanonicalPlanningUuid(value)) throw new CommandValidationError()
  return value
}

export function canonicalCreatePayload(
  payload: CreateEmptyDraftPayload,
): CanonicalJsonObject {
  return snapshotCreatePayload(payload)
}

export function canonicalUpdatePayload(
  payload: UpdateMonthFocusPayload,
): CanonicalJsonObject {
  return snapshotUpdatePayload(payload)
}

export function snapshotCreateEmptyDraftCommand(
  command: unknown,
): CreateEmptyDraftApplicationCommand {
  const hasExpectedRevision =
    exactObject(command, [
      'commandId',
      'trustedActor',
      'expectedRevision',
      'payload',
    ]) && hasOwn(command, 'expectedRevision')
  if (
    !hasExpectedRevision &&
    !exactObject(command, ['commandId', 'trustedActor', 'payload'])
  ) {
    throw new CommandValidationError()
  }
  const commandId = snapshotCommandId(command.commandId)
  const trustedActor = snapshotActor(command.trustedActor)
  const payload = snapshotCreatePayload(command.payload)
  if (!hasExpectedRevision) {
    return Object.freeze({ commandId, trustedActor, payload })
  }
  const expectedRevision = command.expectedRevision
  if (typeof expectedRevision !== 'bigint') {
    throw new CommandValidationError()
  }
  return Object.freeze({
    commandId,
    trustedActor,
    expectedRevision,
    payload,
  })
}

export function snapshotUpdateMonthFocusCommand(
  command: unknown,
): UpdateMonthFocusApplicationCommand {
  if (
    !exactObject(command, [
      'commandId',
      'trustedActor',
      'expectedRevision',
      'payload',
    ])
  ) {
    throw new CommandValidationError()
  }
  const commandId = snapshotCommandId(command.commandId)
  const trustedActor = snapshotActor(command.trustedActor)
  const expectedRevision = command.expectedRevision
  const payload = snapshotUpdatePayload(command.payload)
  if (typeof expectedRevision !== 'bigint') {
    throw new CommandValidationError()
  }
  return Object.freeze({
    commandId,
    trustedActor,
    expectedRevision,
    payload,
  })
}
