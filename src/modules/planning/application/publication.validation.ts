import type { CanonicalJsonObject } from '@/shared/application/application-command'
import { CommandValidationError } from '@/shared/application/application-command'

import { isCanonicalPlanningUuid } from '../domain/planning-values'
import type {
  GetActiveMonthInput,
  GetPublishedSnapshotInput,
  PublishMonthApplicationCommand,
  PublishMonthPayload,
} from './publication.types'

const VERSION = /^[a-z0-9][a-z0-9.-]{0,99}$/u
const HASH = /^[0-9a-f]{64}$/u

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
  const ownKeys = Reflect.ownKeys(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
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

function uuid(value: unknown): string {
  if (!isCanonicalPlanningUuid(value)) throw new CommandValidationError()
  return value
}

function version(value: unknown): string {
  if (typeof value !== 'string' || !VERSION.test(value)) {
    throw new CommandValidationError()
  }
  return value
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new CommandValidationError()
  }
  return value
}

function payload(value: unknown): PublishMonthPayload {
  const input = exact(value, [
    'planMonthId',
    'previewSchemaVersion',
    'previewHashVersion',
    'previewHash',
  ])
  return Object.freeze({
    planMonthId: uuid(input['planMonthId']),
    previewSchemaVersion: version(input['previewSchemaVersion']),
    previewHashVersion: version(input['previewHashVersion']),
    previewHash: hash(input['previewHash']),
  })
}

export function snapshotPublishMonthCommand(
  value: unknown,
): PublishMonthApplicationCommand {
  const input = exact(value, [
    'commandId',
    'trustedActor',
    'expectedRevision',
    'payload',
  ])
  const actor = exact(input['trustedActor'], ['kind', 'id'])
  const expectedRevision = input['expectedRevision']
  if (
    actor['kind'] !== 'member' ||
    !isCanonicalPlanningUuid(actor['id']) ||
    typeof expectedRevision !== 'bigint' ||
    expectedRevision <= 0n
  ) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    commandId: uuid(input['commandId']),
    trustedActor: Object.freeze({ kind: 'member', id: actor['id'] }),
    expectedRevision,
    payload: payload(input['payload']),
  })
}

export function canonicalPublishMonthPayload(
  value: PublishMonthPayload,
): CanonicalJsonObject {
  return payload(value)
}

export function snapshotGetPublishedSnapshotInput(
  value: unknown,
): GetPublishedSnapshotInput {
  const input = exact(value, ['trustedUserId', 'publicationId'])
  return Object.freeze({
    trustedUserId: uuid(input['trustedUserId']),
    publicationId: uuid(input['publicationId']),
  })
}

export function snapshotGetActiveMonthInput(
  value: unknown,
): GetActiveMonthInput {
  const input = exact(value, ['trustedUserId'])
  return Object.freeze({ trustedUserId: uuid(input['trustedUserId']) })
}
