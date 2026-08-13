import type { ActorRef } from '@/shared/application/application-command'
import { CommandValidationError } from '@/shared/application/application-command'

import type {
  GetFactStateInput,
  RecordFactApplicationCommand,
  RecordFactPayload,
  RecordFactValueV1,
} from './tracking.types'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u
const LOCAL_DATE = /^([0-9]{4})-(0[1-9]|1[0-2])-([0-9]{2})$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function ownData(value: Record<string, unknown>, key: string): unknown {
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

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  const keys = Reflect.ownKeys(value)
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new CommandValidationError()
  }
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new CommandValidationError()
  }
  return value
}

function actor(value: unknown): ActorRef {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, ['kind', 'id'])
  const kind = ownData(value, 'kind')
  const id = ownData(value, 'id')
  if (kind === 'member') return Object.freeze({ kind, id: uuid(id) })
  if (kind === 'system' && id === 'planner-worker') {
    return Object.freeze({ kind, id })
  }
  throw new CommandValidationError()
}

export function canonicalLocalDate(value: unknown): string {
  if (typeof value !== 'string') throw new CommandValidationError()
  const match = LOCAL_DATE.exec(value)
  if (match === null) throw new CommandValidationError()
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || year > 9999) throw new CommandValidationError()
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day < 1 || day > days[month - 1]!) {
    throw new CommandValidationError()
  }
  return value
}

export function localDateAt(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new CommandValidationError()
  return canonicalLocalDate(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Yekaterinburg',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(value),
  )
}

function factValue(value: unknown): RecordFactValueV1 {
  if (!isRecord(value)) throw new CommandValidationError()
  const kind = ownData(value, 'kind')
  if (kind === 'boolean') {
    exactKeys(value, ['kind', 'result'])
    const result = ownData(value, 'result')
    if (result !== 'done' && result !== 'not_done') {
      throw new CommandValidationError()
    }
    return Object.freeze({ kind, result })
  }
  if (kind === 'quantity') {
    exactKeys(value, ['kind', 'value'])
    const decimal = ownData(value, 'value')
    if (typeof decimal !== 'string' || !DECIMAL.test(decimal)) {
      throw new CommandValidationError()
    }
    return Object.freeze({ kind, value: decimal })
  }
  throw new CommandValidationError()
}

function payload(value: unknown): RecordFactPayload {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, [
    'publicationId',
    'planGoalSnapshotId',
    'localDate',
    'value',
  ])
  return Object.freeze({
    publicationId: uuid(ownData(value, 'publicationId')),
    planGoalSnapshotId: uuid(ownData(value, 'planGoalSnapshotId')),
    localDate: canonicalLocalDate(ownData(value, 'localDate')),
    value: factValue(ownData(value, 'value')),
  })
}

export function snapshotRecordFactCommand(
  value: unknown,
): RecordFactApplicationCommand {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(
    value,
    ['commandId', 'trustedActor', 'payload'],
    ['expectedRevision'],
  )
  const expectedDescriptor = Object.getOwnPropertyDescriptor(
    value,
    'expectedRevision',
  )
  const expectedRevision: unknown =
    expectedDescriptor === undefined
      ? undefined
      : expectedDescriptor.enumerable && 'value' in expectedDescriptor
        ? expectedDescriptor.value
        : (() => {
            throw new CommandValidationError()
          })()
  if (
    expectedRevision !== undefined &&
    (typeof expectedRevision !== 'bigint' || expectedRevision <= 0n)
  ) {
    throw new CommandValidationError()
  }
  const snapshot = {
    commandId: uuid(ownData(value, 'commandId')),
    trustedActor: actor(ownData(value, 'trustedActor')),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    payload: payload(ownData(value, 'payload')),
  }
  return Object.freeze(snapshot)
}

export function canonicalRecordFactPayload(value: RecordFactPayload): {
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly localDate: string
  readonly value:
    | { readonly kind: 'boolean'; readonly result: 'done' | 'not_done' }
    | { readonly kind: 'quantity'; readonly value: string }
} {
  return payload(value)
}

export function snapshotGetFactStateInput(value: unknown): GetFactStateInput {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, [
    'trustedActor',
    'publicationId',
    'planGoalSnapshotId',
    'localDate',
  ])
  return Object.freeze({
    trustedActor: actor(ownData(value, 'trustedActor')),
    publicationId: uuid(ownData(value, 'publicationId')),
    planGoalSnapshotId: uuid(ownData(value, 'planGoalSnapshotId')),
    localDate: canonicalLocalDate(ownData(value, 'localDate')),
  })
}
