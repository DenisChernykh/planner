import type { TrackingApplication } from '@/modules/tracking'
import {
  canonicalRecordFactPayload,
  FactRevisionConflictError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  FactValueInvalidError,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
  type RecordFactPayload,
} from '@/modules/tracking'
import type { MemberContext } from '@/modules/workspace'
import type {
  CommandDefinition,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import { commandFingerprint } from '@/shared/application/command-fingerprint'

import type {
  StoredTelegramActionIntent,
  TelegramActionIntentValue,
  TelegramIntentOutcome,
} from './action-intent.types'

const definition: CommandDefinition<
  RecordFactPayload,
  'tracking.fact-record.v1'
> = {
  commandType: 'tracking.record-fact.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordFactPayload,
}

export function intentValue(
  intent: StoredTelegramActionIntent,
): TelegramActionIntentValue | null {
  if (intent.intentKind === 'boolean') {
    return intent.booleanResult === null
      ? null
      : { kind: 'boolean', result: intent.booleanResult }
  }
  return intent.quantityValue === null
    ? null
    : { kind: 'quantity', value: intent.quantityValue }
}

export function commandForIntent(
  member: MemberContext,
  intent: StoredTelegramActionIntent,
): {
  readonly commandId: string
  readonly trustedActor: { readonly kind: 'member'; readonly id: string }
  readonly payload: RecordFactPayload
} | null {
  const value = intentValue(intent)
  if (value === null) return null
  return Object.freeze({
    commandId: intent.commandId,
    trustedActor: { kind: 'member' as const, id: member.memberId },
    payload: Object.freeze({
      publicationId: intent.publicationId,
      planGoalSnapshotId: intent.planGoalSnapshotId,
      localDate: intent.localDate,
      value,
    }),
  })
}

export function fingerprintForIntent(
  member: MemberContext,
  intent: StoredTelegramActionIntent,
): string | null {
  const command = commandForIntent(member, intent)
  return command === null ? null : commandFingerprint(definition, command)
}

export async function executeBasicFactIntent(
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
  const command = commandForIntent(member, intent)
  if (command === null || intent.commandFingerprint === null) {
    return { kind: 'stale' }
  }
  if (commandFingerprint(definition, command) !== intent.commandFingerprint) {
    return { kind: 'stale' }
  }
  try {
    return {
      kind: 'completed',
      result: await tracking.recordFact.execute(command),
    }
  } catch (error: unknown) {
    const outcome = basicFactErrorOutcome(error)
    if (outcome !== null) return outcome
    throw error
  }
}

export function basicFactErrorOutcome(
  error: unknown,
): Extract<
  TelegramIntentOutcome,
  { readonly kind: 'stale' | 'blocked' | 'dependency_unavailable' }
> | null {
  if (
    error instanceof FactTargetNotFoundError ||
    error instanceof FactTargetUnavailableError ||
    error instanceof FactRevisionConflictError
  ) {
    return { kind: 'stale' }
  }
  if (
    error instanceof TrackingAuthorizationDeniedError ||
    error instanceof FactValueInvalidError
  ) {
    return { kind: 'blocked' }
  }
  if (error instanceof TrackingDependencyUnavailableError) {
    return { kind: 'dependency_unavailable' }
  }
  return null
}
