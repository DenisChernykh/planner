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
  CreateDraftFromPublicationApplicationCommand,
  CreateDraftFromPublicationPayload,
  CreateDraftFromSeedApplicationCommand,
  CreateDraftFromSeedPayload,
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
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return (
    ownKeys.length === keys.length &&
    ownKeys.every(
      (key) =>
        typeof key === 'string' &&
        keys.includes(key) &&
        descriptors[key]?.get === undefined &&
        descriptors[key]?.set === undefined,
    )
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

function snapshotCopyPayload(
  value: unknown,
): CreateDraftFromPublicationPayload {
  if (!exactObject(value, ['sourcePublicationId', 'targetMonth'])) {
    throw new CommandValidationError()
  }
  if (!isCanonicalPlanningUuid(value.sourcePublicationId)) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    sourcePublicationId: value.sourcePublicationId,
    targetMonth: validateTargetMonth(value.targetMonth),
  })
}

function snapshotSeedPayload(value: unknown): CreateDraftFromSeedPayload {
  if (!exactObject(value, ['targetMonth', 'actorPersona'])) {
    throw new CommandValidationError()
  }
  if (value.actorPersona !== 'memberA' && value.actorPersona !== 'memberB') {
    throw new CommandValidationError()
  }
  return Object.freeze({
    targetMonth: validateTargetMonth(value.targetMonth),
    actorPersona: value.actorPersona,
  })
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

export function canonicalCreateDraftFromPublicationPayload(
  payload: CreateDraftFromPublicationPayload,
): CanonicalJsonObject {
  return snapshotCopyPayload(payload)
}

export function canonicalCreateDraftFromSeedPayload(
  payload: CreateDraftFromSeedPayload,
): CanonicalJsonObject {
  return snapshotSeedPayload(payload)
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

export function snapshotCreateDraftFromPublicationCommand(
  command: unknown,
): CreateDraftFromPublicationApplicationCommand {
  if (!exactObject(command, ['commandId', 'trustedActor', 'payload'])) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    commandId: snapshotCommandId(command.commandId),
    trustedActor: snapshotActor(command.trustedActor),
    payload: snapshotCopyPayload(command.payload),
  })
}

export function snapshotCreateDraftFromSeedCommand(
  command: unknown,
): CreateDraftFromSeedApplicationCommand {
  if (!exactObject(command, ['commandId', 'trustedActor', 'payload'])) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    commandId: snapshotCommandId(command.commandId),
    trustedActor: snapshotActor(command.trustedActor),
    payload: snapshotSeedPayload(command.payload),
  })
}
