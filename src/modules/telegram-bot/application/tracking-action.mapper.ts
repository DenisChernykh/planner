import type { MemberContext } from '@/modules/workspace'
import {
  canonicalCloseDayPayload,
  canonicalCorrectRecordPayload,
  canonicalDeleteRecordPayload,
  canonicalRecordWeeklyTaskResultPayload,
  canonicalUndoLastOwnActionPayload,
  CloseDayAlreadyClosedError,
  CloseDayPreviewConflictError,
  CloseDayRevisionConflictError,
  CloseDayTargetNotFoundError,
  CloseDayTargetUnavailableError,
  FactCorrectionRequiredError,
  FactRevisionConflictError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  FactUndoUnavailableError,
  FactValueInvalidError,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
  WeeklyTaskAlreadySystemClosedError,
  WeeklyTaskTargetNotFoundError,
  WeeklyTaskTargetUnavailableError,
  type CloseDayPayload,
  type CorrectFactValueV1,
  type CorrectRecordPayload,
  type DeleteRecordPayload,
  type RecordWeeklyTaskResultPayload,
  type TrackingApplication,
  type UndoLastOwnActionPayload,
} from '@/modules/tracking'
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

const correctDefinition: CommandDefinition<
  CorrectRecordPayload,
  'tracking.fact-record.v1'
> = {
  commandType: 'tracking.correct-record.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalCorrectRecordPayload,
}
const deleteDefinition: CommandDefinition<
  DeleteRecordPayload,
  'tracking.fact-record.v1'
> = {
  commandType: 'tracking.delete-record.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalDeleteRecordPayload,
}
const undoDefinition: CommandDefinition<
  UndoLastOwnActionPayload,
  'tracking.fact-record.v1'
> = {
  commandType: 'tracking.undo-last-own-action.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalUndoLastOwnActionPayload,
}
const closeDayDefinition: CommandDefinition<
  CloseDayPayload,
  'tracking.day-close.v1'
> = {
  commandType: 'tracking.close-day.v1',
  resultKind: 'tracking.day-close.v1',
  toCanonicalPayload: canonicalCloseDayPayload,
}
const weeklyDefinition: CommandDefinition<
  RecordWeeklyTaskResultPayload,
  'tracking.fact-record.v1'
> = {
  commandType: 'tracking.record-weekly-task-result.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordWeeklyTaskResultPayload,
}

type MemberActor = { readonly kind: 'member'; readonly id: string }
type TrackingIntentCommand =
  | {
      readonly kind: 'correct'
      readonly definition: typeof correctDefinition
      readonly command: {
        readonly commandId: string
        readonly trustedActor: MemberActor
        readonly expectedRevision: bigint
        readonly payload: CorrectRecordPayload
      }
    }
  | {
      readonly kind: 'delete'
      readonly definition: typeof deleteDefinition
      readonly command: {
        readonly commandId: string
        readonly trustedActor: MemberActor
        readonly expectedRevision: bigint
        readonly payload: DeleteRecordPayload
      }
    }
  | {
      readonly kind: 'undo'
      readonly definition: typeof undoDefinition
      readonly command: {
        readonly commandId: string
        readonly trustedActor: MemberActor
        readonly expectedRevision: bigint
        readonly payload: UndoLastOwnActionPayload
      }
    }
  | {
      readonly kind: 'close_day'
      readonly definition: typeof closeDayDefinition
      readonly command: {
        readonly commandId: string
        readonly trustedActor: MemberActor
        readonly expectedRevision: bigint
        readonly payload: CloseDayPayload
      }
    }
  | {
      readonly kind: 'weekly_task_result'
      readonly definition: typeof weeklyDefinition
      readonly command: {
        readonly commandId: string
        readonly trustedActor: MemberActor
        readonly payload: RecordWeeklyTaskResultPayload
      }
    }

function correctionValue(
  intent: StoredTelegramActionIntent,
): CorrectFactValueV1 | null {
  switch (intent.intentKind) {
    case 'correct_boolean':
      return intent.booleanResult === null
        ? null
        : { kind: 'boolean', result: intent.booleanResult }
    case 'correct_quantity':
      return intent.quantityValue === null
        ? null
        : { kind: 'quantity', value: intent.quantityValue }
    case 'correct_actual_time':
      return intent.actualTimeValue === null
        ? null
        : { kind: 'actual_time', value: intent.actualTimeValue }
    case 'correct_rating':
      if (
        intent.ratingValue === null ||
        intent.ratingValue < BigInt(Number.MIN_SAFE_INTEGER) ||
        intent.ratingValue > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        return null
      }
      return { kind: 'rating', value: Number(intent.ratingValue) }
    case 'correct_text':
      return intent.textValue === null || intent.textResult === null
        ? null
        : {
            kind: 'text',
            text: intent.textValue,
            result: intent.textResult,
          }
    case 'correct_checklist_item':
      return intent.checklistItemState === null
        ? null
        : { kind: 'checklist_item', state: intent.checklistItemState }
    case 'correct_or_variant':
      return intent.orVariantValue === null
        ? null
        : { kind: 'or_variant', value: intent.orVariantValue }
    default:
      return null
  }
}

export function trackingIntentValue(
  intent: StoredTelegramActionIntent,
): TelegramActionIntentValue | null {
  const corrected = correctionValue(intent)
  if (corrected !== null) return corrected
  if (intent.intentKind === 'delete_record') {
    return { kind: 'action', label: 'Удалить запись' }
  }
  if (intent.intentKind === 'undo_record') {
    return { kind: 'action', label: 'Отменить последнее собственное действие' }
  }
  if (intent.intentKind === 'close_day') {
    return intent.closeUnresolvedCount === null
      ? null
      : {
          kind: 'action',
          label: `Закрыть день: ${intent.closeUnresolvedCount} незаполненных`,
        }
  }
  if (intent.intentKind === 'weekly_task_result') {
    return intent.booleanResult === null
      ? null
      : { kind: 'boolean', result: intent.booleanResult }
  }
  return null
}

export function trackingCommandForIntent(
  member: MemberContext,
  intent: StoredTelegramActionIntent,
): TrackingIntentCommand | null {
  const trustedActor = { kind: 'member' as const, id: member.memberId }
  if (intent.intentKind.startsWith('correct_')) {
    const value = correctionValue(intent)
    if (
      value === null ||
      intent.factRecordId === null ||
      intent.expectedRecordRevision === null ||
      intent.reason === null
    ) {
      return null
    }
    return {
      kind: 'correct',
      definition: correctDefinition,
      command: Object.freeze({
        commandId: intent.commandId,
        trustedActor,
        expectedRevision: intent.expectedRecordRevision,
        payload: Object.freeze({
          factRecordId: intent.factRecordId,
          value,
          reason: intent.reason,
        }),
      }),
    }
  }
  if (
    (intent.intentKind === 'delete_record' ||
      intent.intentKind === 'undo_record') &&
    intent.factRecordId !== null &&
    intent.expectedRecordRevision !== null
  ) {
    if (intent.intentKind === 'delete_record') {
      if (intent.reason === null) return null
      return {
        kind: 'delete',
        definition: deleteDefinition,
        command: Object.freeze({
          commandId: intent.commandId,
          trustedActor,
          expectedRevision: intent.expectedRecordRevision,
          payload: Object.freeze({
            factRecordId: intent.factRecordId,
            reason: intent.reason,
          }),
        }),
      }
    }
    return {
      kind: 'undo',
      definition: undoDefinition,
      command: Object.freeze({
        commandId: intent.commandId,
        trustedActor,
        expectedRevision: intent.expectedRecordRevision,
        payload: Object.freeze({ factRecordId: intent.factRecordId }),
      }),
    }
  }
  if (intent.intentKind === 'close_day') {
    if (
      intent.closePreviewSchemaVersion !== 'tracking.close-day-preview.v1' ||
      intent.closePreviewHashVersion !== 'tracking.close-day-preview-hash.v1' ||
      intent.closePreviewHash === null
    ) {
      return null
    }
    return {
      kind: 'close_day',
      definition: closeDayDefinition,
      command: Object.freeze({
        commandId: intent.commandId,
        trustedActor,
        expectedRevision: intent.sourceFactsRevision,
        payload: Object.freeze({
          publicationId: intent.publicationId,
          localDate: intent.localDate,
          previewSchemaVersion: intent.closePreviewSchemaVersion,
          previewHashVersion: intent.closePreviewHashVersion,
          previewHash: intent.closePreviewHash,
        }),
      }),
    }
  }
  if (
    intent.intentKind === 'weekly_task_result' &&
    intent.flexiblePeriodId !== null &&
    intent.booleanResult !== null
  ) {
    return {
      kind: 'weekly_task_result',
      definition: weeklyDefinition,
      command: Object.freeze({
        commandId: intent.commandId,
        trustedActor,
        payload: Object.freeze({
          publicationId: intent.publicationId,
          flexiblePeriodId: intent.flexiblePeriodId,
          result: intent.booleanResult,
        }),
      }),
    }
  }
  return null
}

export function trackingFingerprintForIntent(
  member: MemberContext,
  intent: StoredTelegramActionIntent,
): string | null {
  const mapped = trackingCommandForIntent(member, intent)
  if (mapped === null) return null
  switch (mapped.kind) {
    case 'correct':
      return commandFingerprint(correctDefinition, mapped.command)
    case 'delete':
      return commandFingerprint(deleteDefinition, mapped.command)
    case 'undo':
      return commandFingerprint(undoDefinition, mapped.command)
    case 'close_day':
      return commandFingerprint(closeDayDefinition, mapped.command)
    case 'weekly_task_result':
      return commandFingerprint(weeklyDefinition, mapped.command)
  }
}

export function trackingActionErrorOutcome(
  error: unknown,
): Extract<
  TelegramIntentOutcome,
  { readonly kind: 'stale' | 'blocked' | 'dependency_unavailable' }
> | null {
  if (
    error instanceof FactRevisionConflictError ||
    error instanceof FactTargetNotFoundError ||
    error instanceof FactTargetUnavailableError ||
    error instanceof FactUndoUnavailableError ||
    error instanceof FactCorrectionRequiredError ||
    error instanceof WeeklyTaskTargetNotFoundError ||
    error instanceof WeeklyTaskTargetUnavailableError ||
    error instanceof WeeklyTaskAlreadySystemClosedError ||
    error instanceof CloseDayTargetNotFoundError ||
    error instanceof CloseDayTargetUnavailableError ||
    error instanceof CloseDayRevisionConflictError ||
    error instanceof CloseDayPreviewConflictError ||
    error instanceof CloseDayAlreadyClosedError
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

export async function executeTrackingIntent(
  tracking: TrackingApplication,
  member: MemberContext,
  intent: StoredTelegramActionIntent,
): Promise<
  | {
      readonly kind: 'completed'
      readonly result:
        | DurableCommandResultRef<'tracking.fact-record.v1'>
        | DurableCommandResultRef<'tracking.day-close.v1'>
    }
  | Extract<
      TelegramIntentOutcome,
      { readonly kind: 'stale' | 'blocked' | 'dependency_unavailable' }
    >
> {
  const mapped = trackingCommandForIntent(member, intent)
  if (
    mapped === null ||
    intent.commandFingerprint === null ||
    trackingFingerprintForIntent(member, intent) !== intent.commandFingerprint
  ) {
    return { kind: 'stale' }
  }
  try {
    const result =
      mapped.kind === 'correct'
        ? await tracking.correctRecord.execute(mapped.command)
        : mapped.kind === 'delete'
          ? await tracking.deleteRecord.execute(mapped.command)
          : mapped.kind === 'undo'
            ? await tracking.undoLastOwnAction.execute(mapped.command)
            : mapped.kind === 'close_day'
              ? await tracking.closeDay.execute(mapped.command)
              : await tracking.recordWeeklyTaskResult.execute(mapped.command)
    return { kind: 'completed', result }
  } catch (error: unknown) {
    const outcome = trackingActionErrorOutcome(error)
    if (outcome !== null) return outcome
    throw error
  }
}
