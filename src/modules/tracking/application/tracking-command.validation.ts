import type {
  ActorRef,
  ApplicationCommand,
} from '@/shared/application/application-command'
import { CommandValidationError } from '@/shared/application/application-command'

import type {
  GetFactStateInput,
  GetGoalProgressInput,
  CorrectFactValueV1,
  CorrectRecordApplicationCommand,
  CorrectRecordPayload,
  DeleteRecordApplicationCommand,
  DeleteRecordPayload,
  RecordCheckpointApplicationCommand,
  RecordCheckpointPayload,
  RecordCheckpointValueV1,
  RecordChecklistItemApplicationCommand,
  RecordChecklistItemPayload,
  RecordCompositeOccurrenceApplicationCommand,
  RecordCompositeOccurrenceComponentV1,
  RecordCompositeOccurrencePayload,
  RecordFactApplicationCommand,
  RecordFactPayload,
  RecordFactValueV1,
  RecordRatingApplicationCommand,
  RecordRatingPayload,
  RecordOrVariantApplicationCommand,
  RecordOrVariantPayload,
  RecordTimeApplicationCommand,
  RecordTimePayload,
  RecordTextApplicationCommand,
  RecordTextPayload,
  RecordWeeklyTaskResultApplicationCommand,
  RecordWeeklyTaskResultPayload,
  UndoLastOwnActionApplicationCommand,
  UndoLastOwnActionPayload,
} from './tracking.types'
import {
  CLOSE_DAY_PREVIEW_HASH_VERSION,
  CLOSE_DAY_PREVIEW_SCHEMA_VERSION,
  type CloseDayApplicationCommand,
  type CloseDayPayload,
  type PreviewCloseDayInput,
} from './close-day.types'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u
const LOCAL_DATE = /^([0-9]{4})-(0[1-9]|1[0-2])-([0-9]{2})$/u
const LOCAL_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/u
const SHA256 = /^[0-9a-f]{64}$/u

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

export function canonicalLocalTime(value: unknown): string {
  if (typeof value !== 'string' || !LOCAL_TIME.test(value)) {
    throw new CommandValidationError()
  }
  return value
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new CommandValidationError()
  }
  return value
}

function safeRating(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new CommandValidationError()
  return value as number
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

function expectedRevision(value: Record<string, unknown>): bigint | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'expectedRevision')
  if (descriptor === undefined) return undefined
  if (!descriptor.enumerable || !('value' in descriptor)) {
    throw new CommandValidationError()
  }
  const revision: unknown = descriptor.value
  if (typeof revision !== 'bigint' || revision <= 0n) {
    throw new CommandValidationError()
  }
  return revision
}

function commandEnvelope<TPayload>(
  value: unknown,
  readPayload: (payloadValue: unknown) => TPayload,
): ApplicationCommand<TPayload> {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(
    value,
    ['commandId', 'trustedActor', 'payload'],
    ['expectedRevision'],
  )
  const revision = expectedRevision(value)
  return Object.freeze({
    commandId: uuid(ownData(value, 'commandId')),
    trustedActor: actor(ownData(value, 'trustedActor')),
    ...(revision === undefined ? {} : { expectedRevision: revision }),
    payload: readPayload(ownData(value, 'payload')),
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

function timePayload(value: unknown): RecordTimePayload {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, [
    'publicationId',
    'planGoalSnapshotId',
    'expectationDate',
    'value',
  ])
  return Object.freeze({
    publicationId: uuid(ownData(value, 'publicationId')),
    planGoalSnapshotId: uuid(ownData(value, 'planGoalSnapshotId')),
    expectationDate: canonicalLocalDate(ownData(value, 'expectationDate')),
    value: canonicalLocalTime(ownData(value, 'value')),
  })
}

function ratingPayload(value: unknown): RecordRatingPayload {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, [
    'publicationId',
    'planGoalSnapshotId',
    'expectationDate',
    'value',
  ])
  return Object.freeze({
    publicationId: uuid(ownData(value, 'publicationId')),
    planGoalSnapshotId: uuid(ownData(value, 'planGoalSnapshotId')),
    expectationDate: canonicalLocalDate(ownData(value, 'expectationDate')),
    value: safeRating(ownData(value, 'value')),
  })
}

function checkpointValue(value: unknown): RecordCheckpointValueV1 {
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
  if (kind === 'actual_time') {
    exactKeys(value, ['kind', 'value'])
    return Object.freeze({
      kind,
      value: canonicalLocalTime(ownData(value, 'value')),
    })
  }
  if (kind === 'rating') {
    exactKeys(value, ['kind', 'value'])
    return Object.freeze({ kind, value: safeRating(ownData(value, 'value')) })
  }
  throw new CommandValidationError()
}

function checkpointPayload(value: unknown): RecordCheckpointPayload {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, [
    'publicationId',
    'planGoalSnapshotId',
    'expectationDate',
    'checkpointId',
    'value',
  ])
  return Object.freeze({
    publicationId: uuid(ownData(value, 'publicationId')),
    planGoalSnapshotId: uuid(ownData(value, 'planGoalSnapshotId')),
    expectationDate: canonicalLocalDate(ownData(value, 'expectationDate')),
    checkpointId: uuid(ownData(value, 'checkpointId')),
    value: checkpointValue(ownData(value, 'value')),
  })
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value)
}

function completion(value: unknown): 'done' | 'not_done' {
  if (value !== 'done' && value !== 'not_done') {
    throw new CommandValidationError()
  }
  return value
}

function nonEmptyText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CommandValidationError()
  }
  return value
}

function mutationReason(value: unknown): string {
  const result = nonEmptyText(value)
  if (result.length > 2_000) throw new CommandValidationError()
  return result
}

function textPayload(value: unknown): RecordTextPayload {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, [
    'publicationId',
    'planGoalSnapshotId',
    'expectationDate',
    'checkpointId',
    'text',
    'result',
  ])
  return Object.freeze({
    publicationId: uuid(ownData(value, 'publicationId')),
    planGoalSnapshotId: uuid(ownData(value, 'planGoalSnapshotId')),
    expectationDate: canonicalLocalDate(ownData(value, 'expectationDate')),
    checkpointId: nullableUuid(ownData(value, 'checkpointId')),
    text: nonEmptyText(ownData(value, 'text')),
    result: completion(ownData(value, 'result')),
  })
}

function checklistItemPayload(value: unknown): RecordChecklistItemPayload {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, [
    'publicationId',
    'planGoalSnapshotId',
    'expectationDate',
    'checkpointId',
    'checklistItemId',
    'state',
  ])
  return Object.freeze({
    publicationId: uuid(ownData(value, 'publicationId')),
    planGoalSnapshotId: uuid(ownData(value, 'planGoalSnapshotId')),
    expectationDate: canonicalLocalDate(ownData(value, 'expectationDate')),
    checkpointId: nullableUuid(ownData(value, 'checkpointId')),
    checklistItemId: uuid(ownData(value, 'checklistItemId')),
    state: completion(ownData(value, 'state')),
  })
}

function canonicalDecimal(value: unknown): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new CommandValidationError()
  }
  return value
}

function orVariantPayload(value: unknown): RecordOrVariantPayload {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, [
    'publicationId',
    'planGoalSnapshotId',
    'expectationDate',
    'checkpointId',
    'variantId',
    'value',
  ])
  return Object.freeze({
    publicationId: uuid(ownData(value, 'publicationId')),
    planGoalSnapshotId: uuid(ownData(value, 'planGoalSnapshotId')),
    expectationDate: canonicalLocalDate(ownData(value, 'expectationDate')),
    checkpointId: nullableUuid(ownData(value, 'checkpointId')),
    variantId: uuid(ownData(value, 'variantId')),
    value: canonicalDecimal(ownData(value, 'value')),
  })
}

function compositeComponent(
  value: unknown,
): RecordCompositeOccurrenceComponentV1 {
  if (!isRecord(value)) throw new CommandValidationError()
  const kind = ownData(value, 'kind')
  if (kind === 'checklist_item') {
    exactKeys(value, ['kind', 'checklistItemId', 'state'])
    return Object.freeze({
      kind,
      checklistItemId: uuid(ownData(value, 'checklistItemId')),
      state: completion(ownData(value, 'state')),
    })
  }
  if (kind === 'or_variant') {
    exactKeys(value, ['kind', 'variantId', 'value'])
    return Object.freeze({
      kind,
      variantId: uuid(ownData(value, 'variantId')),
      value: canonicalDecimal(ownData(value, 'value')),
    })
  }
  throw new CommandValidationError()
}

function compositeOccurrencePayload(
  value: unknown,
): RecordCompositeOccurrencePayload {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, [
    'publicationId',
    'planGoalSnapshotId',
    'localDate',
    'component',
  ])
  return Object.freeze({
    publicationId: uuid(ownData(value, 'publicationId')),
    planGoalSnapshotId: uuid(ownData(value, 'planGoalSnapshotId')),
    localDate: canonicalLocalDate(ownData(value, 'localDate')),
    component: compositeComponent(ownData(value, 'component')),
  })
}

function weeklyTaskResultPayload(
  value: unknown,
): RecordWeeklyTaskResultPayload {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, ['publicationId', 'flexiblePeriodId', 'result'])
  return Object.freeze({
    publicationId: uuid(ownData(value, 'publicationId')),
    flexiblePeriodId: uuid(ownData(value, 'flexiblePeriodId')),
    result: completion(ownData(value, 'result')),
  })
}

function correctValue(value: unknown): CorrectFactValueV1 {
  if (!isRecord(value)) throw new CommandValidationError()
  const kind = ownData(value, 'kind')
  if (kind === 'boolean' || kind === 'quantity') return factValue(value)
  if (kind === 'actual_time') {
    exactKeys(value, ['kind', 'value'])
    return Object.freeze({
      kind,
      value: canonicalLocalTime(ownData(value, 'value')),
    })
  }
  if (kind === 'rating') {
    exactKeys(value, ['kind', 'value'])
    return Object.freeze({ kind, value: safeRating(ownData(value, 'value')) })
  }
  if (kind === 'text') {
    exactKeys(value, ['kind', 'text', 'result'])
    return Object.freeze({
      kind,
      text: nonEmptyText(ownData(value, 'text')),
      result: completion(ownData(value, 'result')),
    })
  }
  if (kind === 'checklist_item') {
    exactKeys(value, ['kind', 'state'])
    return Object.freeze({ kind, state: completion(ownData(value, 'state')) })
  }
  if (kind === 'or_variant') {
    exactKeys(value, ['kind', 'value'])
    return Object.freeze({
      kind,
      value: canonicalDecimal(ownData(value, 'value')),
    })
  }
  throw new CommandValidationError()
}

function correctRecordPayload(value: unknown): CorrectRecordPayload {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, ['factRecordId', 'value', 'reason'])
  return Object.freeze({
    factRecordId: uuid(ownData(value, 'factRecordId')),
    value: correctValue(ownData(value, 'value')),
    reason: mutationReason(ownData(value, 'reason')),
  })
}

function deleteRecordPayload(value: unknown): DeleteRecordPayload {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, ['factRecordId', 'reason'])
  return Object.freeze({
    factRecordId: uuid(ownData(value, 'factRecordId')),
    reason: mutationReason(ownData(value, 'reason')),
  })
}

function undoLastOwnActionPayload(value: unknown): UndoLastOwnActionPayload {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, ['factRecordId'])
  return Object.freeze({
    factRecordId: uuid(ownData(value, 'factRecordId')),
  })
}

function mutationEnvelope<TPayload>(
  value: unknown,
  readPayload: (payloadValue: unknown) => TPayload,
): ApplicationCommand<TPayload> & { readonly expectedRevision: bigint } {
  const snapshot = commandEnvelope(value, readPayload)
  if (snapshot.expectedRevision === undefined) {
    throw new CommandValidationError()
  }
  return snapshot as ApplicationCommand<TPayload> & {
    readonly expectedRevision: bigint
  }
}

export function snapshotRecordTimeCommand(
  value: unknown,
): RecordTimeApplicationCommand {
  return commandEnvelope(value, timePayload)
}

export function snapshotRecordRatingCommand(
  value: unknown,
): RecordRatingApplicationCommand {
  return commandEnvelope(value, ratingPayload)
}

export function snapshotRecordCheckpointCommand(
  value: unknown,
): RecordCheckpointApplicationCommand {
  return commandEnvelope(value, checkpointPayload)
}

export function snapshotRecordTextCommand(
  value: unknown,
): RecordTextApplicationCommand {
  return commandEnvelope(value, textPayload)
}

export function snapshotRecordChecklistItemCommand(
  value: unknown,
): RecordChecklistItemApplicationCommand {
  return commandEnvelope(value, checklistItemPayload)
}

export function snapshotRecordOrVariantCommand(
  value: unknown,
): RecordOrVariantApplicationCommand {
  return commandEnvelope(value, orVariantPayload)
}

export function snapshotRecordCompositeOccurrenceCommand(
  value: unknown,
): RecordCompositeOccurrenceApplicationCommand {
  return commandEnvelope(value, compositeOccurrencePayload)
}

export function snapshotRecordWeeklyTaskResultCommand(
  value: unknown,
): RecordWeeklyTaskResultApplicationCommand {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, ['commandId', 'trustedActor', 'payload'])
  return Object.freeze({
    commandId: uuid(ownData(value, 'commandId')),
    trustedActor: actor(ownData(value, 'trustedActor')),
    payload: weeklyTaskResultPayload(ownData(value, 'payload')),
  })
}

export function snapshotCorrectRecordCommand(
  value: unknown,
): CorrectRecordApplicationCommand & { readonly expectedRevision: bigint } {
  return mutationEnvelope(value, correctRecordPayload)
}

export function snapshotDeleteRecordCommand(
  value: unknown,
): DeleteRecordApplicationCommand & { readonly expectedRevision: bigint } {
  return mutationEnvelope(value, deleteRecordPayload)
}

export function snapshotUndoLastOwnActionCommand(
  value: unknown,
): UndoLastOwnActionApplicationCommand & { readonly expectedRevision: bigint } {
  return mutationEnvelope(value, undoLastOwnActionPayload)
}

function closeDayPayload(value: unknown): CloseDayPayload {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, [
    'publicationId',
    'localDate',
    'previewSchemaVersion',
    'previewHashVersion',
    'previewHash',
  ])
  const previewSchemaVersion = ownData(value, 'previewSchemaVersion')
  const previewHashVersion = ownData(value, 'previewHashVersion')
  if (
    previewSchemaVersion !== CLOSE_DAY_PREVIEW_SCHEMA_VERSION ||
    previewHashVersion !== CLOSE_DAY_PREVIEW_HASH_VERSION
  ) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    publicationId: uuid(ownData(value, 'publicationId')),
    localDate: canonicalLocalDate(ownData(value, 'localDate')),
    previewSchemaVersion,
    previewHashVersion,
    previewHash: sha256(ownData(value, 'previewHash')),
  })
}

export function snapshotCloseDayCommand(
  value: unknown,
): CloseDayApplicationCommand & { readonly expectedRevision: bigint } {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, ['commandId', 'trustedActor', 'expectedRevision', 'payload'])
  const revision = ownData(value, 'expectedRevision')
  if (typeof revision !== 'bigint' || revision < 0n) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    commandId: uuid(ownData(value, 'commandId')),
    trustedActor: actor(ownData(value, 'trustedActor')),
    expectedRevision: revision,
    payload: closeDayPayload(ownData(value, 'payload')),
  })
}

export function snapshotPreviewCloseDayInput(
  value: unknown,
): PreviewCloseDayInput {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, ['trustedActor', 'publicationId', 'localDate'])
  return Object.freeze({
    trustedActor: actor(ownData(value, 'trustedActor')),
    publicationId: uuid(ownData(value, 'publicationId')),
    localDate: canonicalLocalDate(ownData(value, 'localDate')),
  })
}

export function canonicalRecordTimePayload(
  value: RecordTimePayload,
): RecordTimePayload {
  return timePayload(value)
}

export function canonicalRecordRatingPayload(
  value: RecordRatingPayload,
): RecordRatingPayload {
  return ratingPayload(value)
}

export function canonicalRecordCheckpointPayload(
  value: RecordCheckpointPayload,
): RecordCheckpointPayload {
  return checkpointPayload(value)
}

export function canonicalRecordTextPayload(
  value: RecordTextPayload,
): RecordTextPayload {
  return textPayload(value)
}

export function canonicalRecordChecklistItemPayload(
  value: RecordChecklistItemPayload,
): RecordChecklistItemPayload {
  return checklistItemPayload(value)
}

export function canonicalRecordOrVariantPayload(
  value: RecordOrVariantPayload,
): RecordOrVariantPayload {
  return orVariantPayload(value)
}

export function canonicalRecordCompositeOccurrencePayload(
  value: RecordCompositeOccurrencePayload,
): RecordCompositeOccurrencePayload {
  return compositeOccurrencePayload(value)
}

export function canonicalRecordWeeklyTaskResultPayload(
  value: RecordWeeklyTaskResultPayload,
): RecordWeeklyTaskResultPayload {
  return weeklyTaskResultPayload(value)
}

export function canonicalCorrectRecordPayload(
  value: CorrectRecordPayload,
): CorrectRecordPayload {
  return correctRecordPayload(value)
}

export function canonicalDeleteRecordPayload(
  value: DeleteRecordPayload,
): DeleteRecordPayload {
  return deleteRecordPayload(value)
}

export function canonicalUndoLastOwnActionPayload(
  value: UndoLastOwnActionPayload,
): UndoLastOwnActionPayload {
  return undoLastOwnActionPayload(value)
}

export function canonicalCloseDayPayload(
  value: CloseDayPayload,
): CloseDayPayload {
  return closeDayPayload(value)
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

export function snapshotGetGoalProgressInput(
  value: unknown,
): GetGoalProgressInput {
  if (!isRecord(value)) throw new CommandValidationError()
  exactKeys(value, [
    'trustedActor',
    'publicationId',
    'planGoalSnapshotId',
    'asOfLocalDate',
  ])
  return Object.freeze({
    trustedActor: actor(ownData(value, 'trustedActor')),
    publicationId: uuid(ownData(value, 'publicationId')),
    planGoalSnapshotId: uuid(ownData(value, 'planGoalSnapshotId')),
    asOfLocalDate: canonicalLocalDate(ownData(value, 'asOfLocalDate')),
  })
}
