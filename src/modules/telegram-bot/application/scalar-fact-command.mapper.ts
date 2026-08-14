import type { MemberContext } from '@/modules/workspace'
import {
  canonicalRecordCheckpointPayload,
  canonicalRecordRatingPayload,
  canonicalRecordTimePayload,
  type RecordCheckpointPayload,
  type RecordCheckpointValueV1,
  type RecordRatingPayload,
  type RecordTimePayload,
  type TrackingApplication,
} from '@/modules/tracking'
import type {
  CommandDefinition,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import { commandFingerprint } from '@/shared/application/command-fingerprint'

import { basicFactErrorOutcome } from './basic-fact-command.mapper'
import type {
  StoredTelegramActionIntent,
  TelegramActionIntentValue,
  TelegramIntentOutcome,
} from './action-intent.types'

const timeDefinition: CommandDefinition<
  RecordTimePayload,
  'tracking.fact-record.v1'
> = {
  commandType: 'tracking.record-time.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordTimePayload,
}

const ratingDefinition: CommandDefinition<
  RecordRatingPayload,
  'tracking.fact-record.v1'
> = {
  commandType: 'tracking.record-rating.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordRatingPayload,
}

const checkpointDefinition: CommandDefinition<
  RecordCheckpointPayload,
  'tracking.fact-record.v1'
> = {
  commandType: 'tracking.record-checkpoint.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordCheckpointPayload,
}

type ScalarCommand =
  | {
      readonly kind: 'time'
      readonly definition: typeof timeDefinition
      readonly command: {
        readonly commandId: string
        readonly trustedActor: { readonly kind: 'member'; readonly id: string }
        readonly payload: RecordTimePayload
      }
    }
  | {
      readonly kind: 'rating'
      readonly definition: typeof ratingDefinition
      readonly command: {
        readonly commandId: string
        readonly trustedActor: { readonly kind: 'member'; readonly id: string }
        readonly payload: RecordRatingPayload
      }
    }
  | {
      readonly kind: 'checkpoint'
      readonly definition: typeof checkpointDefinition
      readonly command: {
        readonly commandId: string
        readonly trustedActor: { readonly kind: 'member'; readonly id: string }
        readonly payload: RecordCheckpointPayload
      }
    }

function rating(intent: StoredTelegramActionIntent): number | null {
  if (
    intent.ratingValue === null ||
    intent.ratingValue < BigInt(Number.MIN_SAFE_INTEGER) ||
    intent.ratingValue > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null
  }
  return Number(intent.ratingValue)
}

export function scalarIntentValue(
  intent: StoredTelegramActionIntent,
): TelegramActionIntentValue | null {
  if (
    intent.intentKind === 'actual_time' ||
    intent.intentKind === 'checkpoint_actual_time'
  ) {
    return intent.actualTimeValue === null
      ? null
      : { kind: 'actual_time', value: intent.actualTimeValue }
  }
  if (
    intent.intentKind === 'rating' ||
    intent.intentKind === 'checkpoint_rating'
  ) {
    const value = rating(intent)
    return value === null ? null : { kind: 'rating', value }
  }
  if (intent.intentKind === 'checkpoint_boolean') {
    return intent.booleanResult === null
      ? null
      : { kind: 'boolean', result: intent.booleanResult }
  }
  return null
}

export function scalarCommandForIntent(
  member: MemberContext,
  intent: StoredTelegramActionIntent,
): ScalarCommand | null {
  const actor = { kind: 'member' as const, id: member.memberId }
  const base = {
    publicationId: intent.publicationId,
    planGoalSnapshotId: intent.planGoalSnapshotId,
    expectationDate: intent.localDate,
  }
  if (intent.intentKind === 'actual_time' && intent.actualTimeValue !== null) {
    return {
      kind: 'time',
      definition: timeDefinition,
      command: Object.freeze({
        commandId: intent.commandId,
        trustedActor: actor,
        payload: Object.freeze({ ...base, value: intent.actualTimeValue }),
      }),
    }
  }
  if (intent.intentKind === 'rating') {
    const value = rating(intent)
    if (value === null) return null
    return {
      kind: 'rating',
      definition: ratingDefinition,
      command: Object.freeze({
        commandId: intent.commandId,
        trustedActor: actor,
        payload: Object.freeze({ ...base, value }),
      }),
    }
  }
  if (!intent.intentKind.startsWith('checkpoint_')) return null
  if (intent.checkpointId === null) return null
  const value = scalarIntentValue(intent) as RecordCheckpointValueV1 | null
  if (value === null) return null
  return {
    kind: 'checkpoint',
    definition: checkpointDefinition,
    command: Object.freeze({
      commandId: intent.commandId,
      trustedActor: actor,
      payload: Object.freeze({
        ...base,
        checkpointId: intent.checkpointId,
        value,
      }),
    }),
  }
}

export function scalarFingerprintForIntent(
  member: MemberContext,
  intent: StoredTelegramActionIntent,
): string | null {
  const value = scalarCommandForIntent(member, intent)
  if (value === null) return null
  switch (value.kind) {
    case 'time':
      return commandFingerprint(timeDefinition, value.command)
    case 'rating':
      return commandFingerprint(ratingDefinition, value.command)
    case 'checkpoint':
      return commandFingerprint(checkpointDefinition, value.command)
  }
}

export async function executeScalarFactIntent(
  tracking: TrackingApplication,
  member: MemberContext,
  intent: StoredTelegramActionIntent,
): Promise<
  | {
      readonly kind: 'completed'
      readonly result: DurableCommandResultRef<'tracking.fact-record.v1'>
    }
  | Extract<
      TelegramIntentOutcome,
      { readonly kind: 'stale' | 'blocked' | 'dependency_unavailable' }
    >
> {
  const value = scalarCommandForIntent(member, intent)
  if (
    value === null ||
    intent.commandFingerprint === null ||
    scalarFingerprintForIntent(member, intent) !== intent.commandFingerprint
  ) {
    return { kind: 'stale' }
  }
  try {
    const result =
      value.kind === 'time'
        ? await tracking.recordTime.execute(value.command)
        : value.kind === 'rating'
          ? await tracking.recordRating.execute(value.command)
          : await tracking.recordCheckpoint.execute(value.command)
    return { kind: 'completed', result }
  } catch (error: unknown) {
    const outcome = basicFactErrorOutcome(error)
    if (outcome !== null) return outcome
    throw error
  }
}
