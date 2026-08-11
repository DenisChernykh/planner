import type {
  ActorRef,
  CanonicalJsonObject,
} from '@/shared/application/application-command'
import { CommandValidationError } from '@/shared/application/application-command'

import { isCanonicalPlanningUuid } from '../domain/planning-values'
import type {
  ArchiveGoalDefinitionApplicationCommand,
  CopyGoalDefinitionApplicationCommand,
  CopyGoalDefinitionPayload,
  CreateGoalDefinitionApplicationCommand,
  CreateGoalDefinitionPayload,
  CreateGoalDefinitionVersionApplicationCommand,
  CreateGoalDefinitionVersionPayload,
  GetGoalDefinitionInput,
  GoalDefinitionIdentityPayload,
  GoalDefinitionListState,
  ListGoalDefinitionsInput,
  RestoreGoalDefinitionApplicationCommand,
  SeriesDecision,
} from './goal-catalog.types'

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

function snapshotActor(value: unknown): ActorRef {
  if (!exactObject(value, ['kind', 'id'])) throw new CommandValidationError()
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

function uuid(value: unknown): string {
  if (!isCanonicalPlanningUuid(value)) throw new CommandValidationError()
  return value
}

function metadataString(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    [...value].length > maximum
  ) {
    throw new CommandValidationError()
  }
  return value
}

function metadata(value: unknown): CreateGoalDefinitionPayload {
  if (!exactObject(value, ['title', 'why', 'category'])) {
    throw new CommandValidationError()
  }
  const title = metadataString(value.title, 200)
  const why = metadataString(value.why, 2_000)
  const category = metadataString(value.category, 100)
  return Object.freeze({ title, why, category })
}

function decision(value: unknown): SeriesDecision {
  if (value !== 'continue' && value !== 'new') {
    throw new CommandValidationError()
  }
  return value
}

function positiveRevision(value: unknown): bigint {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new CommandValidationError()
  }
  return value
}

function commandBase(value: unknown): {
  readonly commandId: string
  readonly trustedActor: ActorRef
} {
  if (typeof value !== 'object' || value === null) {
    throw new CommandValidationError()
  }
  const record = value as Record<string, unknown>
  return {
    commandId: uuid(record['commandId']),
    trustedActor: snapshotActor(record['trustedActor']),
  }
}

export function canonicalCreateGoalDefinitionPayload(
  payload: CreateGoalDefinitionPayload,
): CanonicalJsonObject {
  return metadata(payload)
}

export function canonicalCreateGoalDefinitionVersionPayload(
  payload: CreateGoalDefinitionVersionPayload,
): CanonicalJsonObject {
  if (
    !exactObject(payload, [
      'goalDefinitionId',
      'title',
      'why',
      'category',
      'seriesDecision',
    ])
  ) {
    throw new CommandValidationError()
  }
  const goalDefinitionId = uuid(payload.goalDefinitionId)
  const title = metadataString(payload.title, 200)
  const why = metadataString(payload.why, 2_000)
  const category = metadataString(payload.category, 100)
  const seriesDecision = decision(payload.seriesDecision)
  return Object.freeze({
    goalDefinitionId,
    title,
    why,
    category,
    seriesDecision,
  })
}

function canonicalIdentityPayload(
  payload: GoalDefinitionIdentityPayload,
): CanonicalJsonObject {
  if (!exactObject(payload, ['goalDefinitionId'])) {
    throw new CommandValidationError()
  }
  return Object.freeze({ goalDefinitionId: uuid(payload.goalDefinitionId) })
}

export const canonicalArchiveGoalDefinitionPayload = canonicalIdentityPayload
export const canonicalRestoreGoalDefinitionPayload = canonicalIdentityPayload

export function canonicalCopyGoalDefinitionPayload(
  payload: CopyGoalDefinitionPayload,
): CanonicalJsonObject {
  if (!exactObject(payload, ['sourceGoalDefinitionId'])) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    sourceGoalDefinitionId: uuid(payload.sourceGoalDefinitionId),
  })
}

export function snapshotCreateGoalDefinitionCommand(
  value: unknown,
): CreateGoalDefinitionApplicationCommand {
  if (!exactObject(value, ['commandId', 'trustedActor', 'payload'])) {
    throw new CommandValidationError()
  }
  const base = commandBase(value)
  return Object.freeze({ ...base, payload: metadata(value.payload) })
}

export function snapshotCreateGoalDefinitionVersionCommand(
  value: unknown,
): CreateGoalDefinitionVersionApplicationCommand {
  if (
    !exactObject(value, [
      'commandId',
      'trustedActor',
      'expectedRevision',
      'payload',
    ])
  ) {
    throw new CommandValidationError()
  }
  const base = commandBase(value)
  const expectedRevision = positiveRevision(value.expectedRevision)
  const payload = canonicalCreateGoalDefinitionVersionPayload(
    value.payload as CreateGoalDefinitionVersionPayload,
  ) as CreateGoalDefinitionVersionPayload
  return Object.freeze({ ...base, expectedRevision, payload })
}

function snapshotStateCommand(
  value: unknown,
): ArchiveGoalDefinitionApplicationCommand {
  if (
    !exactObject(value, [
      'commandId',
      'trustedActor',
      'expectedRevision',
      'payload',
    ])
  ) {
    throw new CommandValidationError()
  }
  const base = commandBase(value)
  const expectedRevision = positiveRevision(value.expectedRevision)
  const payload = canonicalIdentityPayload(
    value.payload as GoalDefinitionIdentityPayload,
  ) as GoalDefinitionIdentityPayload
  return Object.freeze({ ...base, expectedRevision, payload })
}

export const snapshotArchiveGoalDefinitionCommand = snapshotStateCommand
export const snapshotRestoreGoalDefinitionCommand = (
  value: unknown,
): RestoreGoalDefinitionApplicationCommand => snapshotStateCommand(value)

export function snapshotCopyGoalDefinitionCommand(
  value: unknown,
): CopyGoalDefinitionApplicationCommand {
  if (
    !exactObject(value, [
      'commandId',
      'trustedActor',
      'expectedRevision',
      'payload',
    ])
  ) {
    throw new CommandValidationError()
  }
  const base = commandBase(value)
  const expectedRevision = positiveRevision(value.expectedRevision)
  const payload = canonicalCopyGoalDefinitionPayload(
    value.payload as CopyGoalDefinitionPayload,
  ) as CopyGoalDefinitionPayload
  return Object.freeze({ ...base, expectedRevision, payload })
}

export function snapshotGoalDefinitionListInput(
  value: unknown,
): Required<ListGoalDefinitionsInput> {
  if (
    !exactObject(value, ['trustedActor']) &&
    !exactObject(value, ['trustedActor', 'state'])
  ) {
    throw new CommandValidationError()
  }
  const trustedActor = snapshotActor(value.trustedActor)
  const state = (value.state ?? 'active') as GoalDefinitionListState
  if (!['active', 'archived', 'all'].includes(state)) {
    throw new CommandValidationError()
  }
  return Object.freeze({ trustedActor, state })
}

export function snapshotGetGoalDefinitionInput(
  value: unknown,
): GetGoalDefinitionInput {
  if (!exactObject(value, ['trustedActor', 'goalDefinitionId'])) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    trustedActor: snapshotActor(value.trustedActor),
    goalDefinitionId: uuid(value.goalDefinitionId),
  })
}
