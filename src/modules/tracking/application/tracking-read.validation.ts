import { CommandValidationError } from '@/shared/application/application-command'
import type { ActorRef } from '@/shared/application/application-command'
import { isCanonicalCalendarMonth } from '@/modules/planning/domain/planning-values'

import type { GetMonthInput, GetTodayInput } from './tracking-read.types'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

function record(value: unknown): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CommandValidationError()
  }
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new CommandValidationError()
  }
}

function data(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !('value' in descriptor)
  ) {
    throw new CommandValidationError()
  }
  return descriptor.value
}

function actor(value: unknown): ActorRef {
  const item = record(value)
  exact(item, ['kind', 'id'])
  const kind = data(item, 'kind')
  const id = data(item, 'id')
  if (kind === 'member' && typeof id === 'string' && UUID.test(id)) {
    return Object.freeze({ kind, id })
  }
  if (kind === 'system' && id === 'planner-worker') {
    return Object.freeze({ kind, id })
  }
  throw new CommandValidationError()
}

function month(value: unknown): string {
  if (!isCanonicalCalendarMonth(value)) {
    throw new CommandValidationError()
  }
  return value
}

export function snapshotGetTodayInput(value: unknown): GetTodayInput {
  const item = record(value)
  exact(item, ['trustedActor'])
  return Object.freeze({ trustedActor: actor(data(item, 'trustedActor')) })
}

export function snapshotGetMonthInput(value: unknown): GetMonthInput {
  const item = record(value)
  exact(item, ['trustedActor', 'targetMonth'])
  return Object.freeze({
    trustedActor: actor(data(item, 'trustedActor')),
    targetMonth: month(data(item, 'targetMonth')),
  })
}
