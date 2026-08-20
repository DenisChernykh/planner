import type { ActorRef } from '@/shared/application/application-command'
import { CommandValidationError } from '@/shared/application/application-command'

import {
  REMINDER_TIME_ZONE,
  type SaveReminderScheduleApplicationCommand,
  type SaveReminderSchedulePayload,
} from './reminder.types'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u

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

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new CommandValidationError()
  }
  return value
}

function actor(value: unknown): ActorRef {
  if (!exactObject(value, ['kind', 'id'])) {
    throw new CommandValidationError()
  }
  if (value.kind !== 'member') throw new CommandValidationError()
  return Object.freeze({ kind: 'member' as const, id: uuid(value.id) })
}

function time(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !TIME.test(value)) {
    throw new CommandValidationError()
  }
  return value
}

function payload(value: unknown): SaveReminderSchedulePayload {
  if (!exactObject(value, ['timeZone', 'morning', 'day', 'evening'])) {
    throw new CommandValidationError()
  }
  if (value.timeZone !== REMINDER_TIME_ZONE) {
    throw new CommandValidationError()
  }
  const slots = {
    morning: time(value.morning),
    day: time(value.day),
    evening: time(value.evening),
  }
  const enabled = Object.values(slots).filter(
    (slot): slot is string => slot !== null,
  )
  for (let index = 1; index < enabled.length; index += 1) {
    if (enabled[index - 1]! >= enabled[index]!) {
      throw new CommandValidationError()
    }
  }
  return Object.freeze({ timeZone: REMINDER_TIME_ZONE, ...slots })
}

export function snapshotSaveReminderScheduleCommand(
  value: unknown,
): SaveReminderScheduleApplicationCommand {
  if (typeof value !== 'object' || value === null) {
    throw new CommandValidationError()
  }
  const command = value as Record<string, unknown>
  const hasExpected = Object.prototype.hasOwnProperty.call(
    command,
    'expectedRevision',
  )
  const keys = hasExpected
    ? ['commandId', 'trustedActor', 'expectedRevision', 'payload']
    : ['commandId', 'trustedActor', 'payload']
  if (!exactObject(value, keys)) throw new CommandValidationError()
  const commandId = uuid(command.commandId)
  const trustedActor = actor(command.trustedActor)
  const expectedRevision = command.expectedRevision
  if (
    hasExpected &&
    (typeof expectedRevision !== 'bigint' || expectedRevision <= 0n)
  ) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    commandId,
    trustedActor,
    ...(hasExpected ? { expectedRevision: expectedRevision as bigint } : {}),
    payload: payload(command.payload),
  })
}
