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
export type TelegramActionIntentState =
  'offered' | 'awaiting_value' | 'ready' | 'completed' | 'expired'

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

export type TelegramActionIntentOffer = {
  readonly actionIntentId: string
  readonly semanticKey: string
  readonly spaceId: string
  readonly memberId: string
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly localDate: string
  readonly sourceFactsRevision: bigint
  readonly intentKind: TelegramActionIntentKind
  readonly checkpointId: string | null
  readonly booleanResult: 'done' | 'not_done' | null
  readonly textResult: 'done' | 'not_done' | null
  readonly checklistItemId: string | null
  readonly checklistItemState: 'done' | 'not_done' | null
  readonly orVariantId: string | null
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
  readonly planGoalSnapshotId: string
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
  readonly commandFingerprint: string | null
  readonly expiresAt: Date
  readonly title: string
  readonly unit: string | null
  readonly precision: 0 | 1 | 2 | 3 | null
  readonly aggregation: 'add' | 'latest' | null
  readonly result: DurableCommandResultRef<'tracking.fact-record.v1'> | null
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
    readonly commandFingerprint: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null>
  markCompleted(input: {
    readonly actionIntentId: string
    readonly result: DurableCommandResultRef<'tracking.fact-record.v1'>
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
    }
  | {
      readonly kind: 'completed'
      readonly title: string
      readonly result: DurableCommandResultRef<'tracking.fact-record.v1'>
    }
  | { readonly kind: 'stale' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'dependency_unavailable' }
