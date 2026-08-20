import type { DurableCommandResultRef } from '@/shared/application/application-command'

export type TelegramActionIntentKind =
  | 'boolean'
  | 'quantity'
  | 'actual_time'
  | 'rating'
  | 'checkpoint_boolean'
  | 'checkpoint_actual_time'
  | 'checkpoint_rating'
  | 'text'
  | 'checkpoint_text'
  | 'checklist_item'
  | 'checkpoint_checklist_item'
  | 'or_variant'
  | 'checkpoint_or_variant'
  | 'composite_checklist_item'
  | 'composite_or_variant'
  | 'correct_boolean'
  | 'correct_quantity'
  | 'correct_actual_time'
  | 'correct_rating'
  | 'correct_text'
  | 'correct_checklist_item'
  | 'correct_or_variant'
  | 'delete_record'
  | 'undo_record'
  | 'close_day'
  | 'weekly_task_result'
export type TelegramActionIntentState =
  | 'offered'
  | 'awaiting_value'
  | 'awaiting_reason'
  | 'ready'
  | 'completed'
  | 'expired'

export type TelegramActionIntentValue =
  | { readonly kind: 'boolean'; readonly result: 'done' | 'not_done' }
  | { readonly kind: 'quantity'; readonly value: string }
  | { readonly kind: 'actual_time'; readonly value: string }
  | { readonly kind: 'rating'; readonly value: number }
  | {
      readonly kind: 'text'
      readonly text: string
      readonly result: 'done' | 'not_done'
    }
  | { readonly kind: 'checklist_item'; readonly state: 'done' | 'not_done' }
  | { readonly kind: 'or_variant'; readonly value: string }
  | { readonly kind: 'action'; readonly label: string }

export type TelegramActionIntentOffer = {
  readonly actionIntentId: string
  readonly semanticKey: string
  readonly spaceId: string
  readonly memberId: string
  readonly publicationId: string
  readonly planGoalSnapshotId: string | null
  readonly localDate: string
  readonly sourceFactsRevision: bigint
  readonly intentKind: TelegramActionIntentKind
  readonly checkpointId: string | null
  readonly booleanResult: 'done' | 'not_done' | null
  readonly textResult: 'done' | 'not_done' | null
  readonly checklistItemId: string | null
  readonly checklistItemState: 'done' | 'not_done' | null
  readonly orVariantId: string | null
  readonly factRecordId: string | null
  readonly expectedRecordRevision: bigint | null
  readonly flexiblePeriodId: string | null
  readonly reason: string | null
  readonly closePreviewSchemaVersion: string | null
  readonly closePreviewHashVersion: string | null
  readonly closePreviewHash: string | null
  readonly closeUnresolvedCount: number | null
  readonly commandFingerprint: string | null
  readonly state: Extract<TelegramActionIntentState, 'offered' | 'ready'>
  readonly expiresAt: Date
}

export type StoredTelegramActionIntent = {
  readonly actionIntentId: string
  readonly commandId: string
  readonly spaceId: string
  readonly memberId: string
  readonly publicationId: string
  readonly planGoalSnapshotId: string | null
  readonly localDate: string
  readonly sourceFactsRevision: bigint
  readonly currentFactsRevision: bigint
  readonly activePublicationId: string | null
  readonly monthStatus: 'draft' | 'published' | 'grace' | 'closed'
  readonly intentKind: TelegramActionIntentKind
  readonly state: TelegramActionIntentState
  readonly checkpointId: string | null
  readonly booleanResult: 'done' | 'not_done' | null
  readonly textResult: 'done' | 'not_done' | null
  readonly checklistItemId: string | null
  readonly checklistItemState: 'done' | 'not_done' | null
  readonly orVariantId: string | null
  readonly quantityValue: string | null
  readonly actualTimeValue: string | null
  readonly ratingValue: bigint | null
  readonly textValue: string | null
  readonly orVariantValue: string | null
  readonly factRecordId: string | null
  readonly expectedRecordRevision: bigint | null
  readonly flexiblePeriodId: string | null
  readonly reason: string | null
  readonly closePreviewSchemaVersion: string | null
  readonly closePreviewHashVersion: string | null
  readonly closePreviewHash: string | null
  readonly closeUnresolvedCount: number | null
  readonly commandFingerprint: string | null
  readonly expiresAt: Date
  readonly title: string
  readonly unit: string | null
  readonly precision: 0 | 1 | 2 | 3 | null
  readonly aggregation: 'add' | 'latest' | null
  readonly result:
    | DurableCommandResultRef<'tracking.fact-record.v1'>
    | DurableCommandResultRef<'tracking.day-close.v1'>
    | null
}

export interface TelegramActionIntentPersistencePort {
  offer(
    input: TelegramActionIntentOffer,
    now: Date,
  ): Promise<StoredTelegramActionIntent>
  lockForMember(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
  }): Promise<StoredTelegramActionIntent | null>
  selectValue(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null>
  findAwaitingValue(input: {
    readonly spaceId: string
    readonly memberId: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null>
  setValue(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
    readonly quantityValue: string | null
    readonly actualTimeValue: string | null
    readonly ratingValue: bigint | null
    readonly textValue: string | null
    readonly orVariantValue: string | null
    readonly commandFingerprint: string | null
    readonly nextState: 'ready' | 'awaiting_reason'
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null>
  beginReason(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null>
  setReason(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
    readonly reason: string
    readonly commandFingerprint: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null>
  prepareCloseDay(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
    readonly sourceFactsRevision: bigint
    readonly previewSchemaVersion: string
    readonly previewHashVersion: string
    readonly previewHash: string
    readonly unresolvedCount: number
    readonly commandFingerprint: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null>
  markCompleted(input: {
    readonly actionIntentId: string
    readonly result:
      | DurableCommandResultRef<'tracking.fact-record.v1'>
      | DurableCommandResultRef<'tracking.day-close.v1'>
    readonly completedAt: Date
  }): Promise<void>
  markExpired(actionIntentId: string, now: Date): Promise<void>
}

export type TelegramActionButton = {
  readonly text: string
  readonly actionIntentId: string
}

export type TelegramIntentOutcome =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'awaiting_quantity'; readonly title: string }
  | { readonly kind: 'invalid_quantity'; readonly title: string }
  | { readonly kind: 'awaiting_text'; readonly title: string }
  | { readonly kind: 'invalid_text'; readonly title: string }
  | { readonly kind: 'awaiting_or_variant'; readonly title: string }
  | { readonly kind: 'invalid_or_variant'; readonly title: string }
  | { readonly kind: 'awaiting_reason'; readonly title: string }
  | { readonly kind: 'invalid_reason'; readonly title: string }
  | {
      readonly kind: 'awaiting_scalar'
      readonly title: string
      readonly inputKind: 'actual_time' | 'rating'
    }
  | {
      readonly kind: 'invalid_scalar'
      readonly title: string
      readonly inputKind: 'actual_time' | 'rating'
    }
  | {
      readonly kind: 'preview'
      readonly actionIntentId: string
      readonly title: string
      readonly localDate: string
      readonly value: TelegramActionIntentValue
      readonly unit: string | null
      readonly aggregation: 'add' | 'latest' | null
      readonly reason: string | null
    }
  | {
      readonly kind: 'completed'
      readonly title: string
      readonly result:
        | DurableCommandResultRef<'tracking.fact-record.v1'>
        | DurableCommandResultRef<'tracking.day-close.v1'>
    }
  | { readonly kind: 'stale' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'dependency_unavailable' }
