import type { MemberContext } from '@/modules/workspace'
import {
  canonicalRecordChecklistItemPayload,
  canonicalRecordCompositeOccurrencePayload,
  canonicalRecordOrVariantPayload,
  canonicalRecordTextPayload,
  type RecordChecklistItemPayload,
  type RecordCompositeOccurrencePayload,
  type RecordOrVariantPayload,
  type RecordTextPayload,
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

const textDefinition: CommandDefinition<
  RecordTextPayload,
  'tracking.fact-record.v1'
> = {
  commandType: 'tracking.record-text.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordTextPayload,
}

const checklistDefinition: CommandDefinition<
  RecordChecklistItemPayload,
  'tracking.fact-record.v1'
> = {
  commandType: 'tracking.record-checklist-item.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordChecklistItemPayload,
}

const orVariantDefinition: CommandDefinition<
  RecordOrVariantPayload,
  'tracking.fact-record.v1'
> = {
  commandType: 'tracking.record-or-variant.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordOrVariantPayload,
}

const compositeDefinition: CommandDefinition<
  RecordCompositeOccurrencePayload,
  'tracking.fact-record.v1'
> = {
  commandType: 'tracking.record-composite-occurrence.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordCompositeOccurrencePayload,
}

type CompositeCommand =
  | {
      readonly kind: 'text'
      readonly definition: typeof textDefinition
      readonly command: {
        readonly commandId: string
        readonly trustedActor: { readonly kind: 'member'; readonly id: string }
        readonly payload: RecordTextPayload
      }
    }
  | {
      readonly kind: 'checklist'
      readonly definition: typeof checklistDefinition
      readonly command: {
        readonly commandId: string
        readonly trustedActor: { readonly kind: 'member'; readonly id: string }
        readonly payload: RecordChecklistItemPayload
      }
    }
  | {
      readonly kind: 'or_variant'
      readonly definition: typeof orVariantDefinition
      readonly command: {
        readonly commandId: string
        readonly trustedActor: { readonly kind: 'member'; readonly id: string }
        readonly payload: RecordOrVariantPayload
      }
    }
  | {
      readonly kind: 'composite'
      readonly definition: typeof compositeDefinition
      readonly command: {
        readonly commandId: string
        readonly trustedActor: { readonly kind: 'member'; readonly id: string }
        readonly payload: RecordCompositeOccurrencePayload
      }
    }

function isText(intent: StoredTelegramActionIntent): boolean {
  return intent.intentKind === 'text' || intent.intentKind === 'checkpoint_text'
}

function isChecklist(intent: StoredTelegramActionIntent): boolean {
  return (
    intent.intentKind === 'checklist_item' ||
    intent.intentKind === 'checkpoint_checklist_item'
  )
}

function isOrVariant(intent: StoredTelegramActionIntent): boolean {
  return (
    intent.intentKind === 'or_variant' ||
    intent.intentKind === 'checkpoint_or_variant'
  )
}

function isCompositeChecklist(intent: StoredTelegramActionIntent): boolean {
  return intent.intentKind === 'composite_checklist_item'
}

function isCompositeOrVariant(intent: StoredTelegramActionIntent): boolean {
  return intent.intentKind === 'composite_or_variant'
}

export function compositeIntentValue(
  intent: StoredTelegramActionIntent,
): TelegramActionIntentValue | null {
  if (isText(intent)) {
    return intent.textValue === null || intent.textResult === null
      ? null
      : {
          kind: 'text',
          text: intent.textValue,
          result: intent.textResult,
        }
  }
  if (isChecklist(intent) || isCompositeChecklist(intent)) {
    return intent.checklistItemState === null
      ? null
      : { kind: 'checklist_item', state: intent.checklistItemState }
  }
  if (isOrVariant(intent) || isCompositeOrVariant(intent)) {
    return intent.orVariantValue === null
      ? null
      : { kind: 'or_variant', value: intent.orVariantValue }
  }
  return null
}

export function compositeCommandForIntent(
  member: MemberContext,
  intent: StoredTelegramActionIntent,
): CompositeCommand | null {
  if (intent.planGoalSnapshotId === null) return null
  const actor = { kind: 'member' as const, id: member.memberId }
  if (isText(intent)) {
    if (intent.textValue === null || intent.textResult === null) return null
    return {
      kind: 'text',
      definition: textDefinition,
      command: Object.freeze({
        commandId: intent.commandId,
        trustedActor: actor,
        payload: Object.freeze({
          publicationId: intent.publicationId,
          planGoalSnapshotId: intent.planGoalSnapshotId,
          expectationDate: intent.localDate,
          checkpointId: intent.checkpointId,
          text: intent.textValue,
          result: intent.textResult,
        }),
      }),
    }
  }
  if (isChecklist(intent)) {
    if (intent.checklistItemId === null || intent.checklistItemState === null) {
      return null
    }
    return {
      kind: 'checklist',
      definition: checklistDefinition,
      command: Object.freeze({
        commandId: intent.commandId,
        trustedActor: actor,
        payload: Object.freeze({
          publicationId: intent.publicationId,
          planGoalSnapshotId: intent.planGoalSnapshotId,
          expectationDate: intent.localDate,
          checkpointId: intent.checkpointId,
          checklistItemId: intent.checklistItemId,
          state: intent.checklistItemState,
        }),
      }),
    }
  }
  if (isOrVariant(intent)) {
    if (intent.orVariantId === null || intent.orVariantValue === null) {
      return null
    }
    return {
      kind: 'or_variant',
      definition: orVariantDefinition,
      command: Object.freeze({
        commandId: intent.commandId,
        trustedActor: actor,
        payload: Object.freeze({
          publicationId: intent.publicationId,
          planGoalSnapshotId: intent.planGoalSnapshotId,
          expectationDate: intent.localDate,
          checkpointId: intent.checkpointId,
          variantId: intent.orVariantId,
          value: intent.orVariantValue,
        }),
      }),
    }
  }
  if (isCompositeChecklist(intent)) {
    if (intent.checklistItemId === null || intent.checklistItemState === null) {
      return null
    }
    return {
      kind: 'composite',
      definition: compositeDefinition,
      command: Object.freeze({
        commandId: intent.commandId,
        trustedActor: actor,
        payload: Object.freeze({
          publicationId: intent.publicationId,
          planGoalSnapshotId: intent.planGoalSnapshotId,
          localDate: intent.localDate,
          component: Object.freeze({
            kind: 'checklist_item' as const,
            checklistItemId: intent.checklistItemId,
            state: intent.checklistItemState,
          }),
        }),
      }),
    }
  }
  if (isCompositeOrVariant(intent)) {
    if (intent.orVariantId === null || intent.orVariantValue === null) {
      return null
    }
    return {
      kind: 'composite',
      definition: compositeDefinition,
      command: Object.freeze({
        commandId: intent.commandId,
        trustedActor: actor,
        payload: Object.freeze({
          publicationId: intent.publicationId,
          planGoalSnapshotId: intent.planGoalSnapshotId,
          localDate: intent.localDate,
          component: Object.freeze({
            kind: 'or_variant' as const,
            variantId: intent.orVariantId,
            value: intent.orVariantValue,
          }),
        }),
      }),
    }
  }
  return null
}

export function compositeFingerprintForIntent(
  member: MemberContext,
  intent: StoredTelegramActionIntent,
): string | null {
  const command = compositeCommandForIntent(member, intent)
  if (command === null) return null
  switch (command.kind) {
    case 'text':
      return commandFingerprint(textDefinition, command.command)
    case 'checklist':
      return commandFingerprint(checklistDefinition, command.command)
    case 'or_variant':
      return commandFingerprint(orVariantDefinition, command.command)
    case 'composite':
      return commandFingerprint(compositeDefinition, command.command)
  }
}

export async function executeCompositeFactIntent(
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
  const command = compositeCommandForIntent(member, intent)
  if (
    command === null ||
    intent.commandFingerprint === null ||
    compositeFingerprintForIntent(member, intent) !== intent.commandFingerprint
  ) {
    return { kind: 'stale' }
  }
  try {
    const result =
      command.kind === 'text'
        ? await tracking.recordText.execute(command.command)
        : command.kind === 'checklist'
          ? await tracking.recordChecklistItem.execute(command.command)
          : command.kind === 'or_variant'
            ? await tracking.recordOrVariant.execute(command.command)
            : await tracking.recordCompositeOccurrence.execute(command.command)
    return { kind: 'completed', result }
  } catch (error: unknown) {
    const outcome = basicFactErrorOutcome(error)
    if (outcome !== null) return outcome
    throw error
  }
}
