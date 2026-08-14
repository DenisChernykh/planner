import type { DurableCommandResultRef } from '@/shared/application/application-command'

export type TelegramActionIntentKind = 'boolean' | 'quantity'
export type TelegramActionIntentState =
  'offered' | 'awaiting_value' | 'ready' | 'completed' | 'expired'

export type TelegramActionIntentValue =
  | { readonly kind: 'boolean'; readonly result: 'done' | 'not_done' }
  | { readonly kind: 'quantity'; readonly value: string }

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
  readonly booleanResult: 'done' | 'not_done' | null
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
  readonly booleanResult: 'done' | 'not_done' | null
  readonly quantityValue: string | null
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
  selectQuantity(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null>
  findAwaitingQuantity(input: {
    readonly spaceId: string
    readonly memberId: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null>
  setQuantityValue(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
    readonly value: string
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
