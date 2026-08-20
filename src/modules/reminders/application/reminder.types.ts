import type {
  ActorRef,
  ApplicationCommand,
  CanonicalJsonObject,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import type { TrackingTodayReadModelV1 } from '@/modules/tracking/application/tracking-read.types'
import type {
  ReminderContentItem as DomainReminderContentItem,
  ReminderRenderedContent as DomainReminderRenderedContent,
} from '../domain/reminder-relevance'

export const REMINDER_TIME_ZONE = 'Asia/Yekaterinburg' as const
export const REMINDER_SCHEDULE_RESULT_KIND = 'reminders.schedule.v1' as const
export const REMINDER_CONTENT_SCHEMA_VERSION =
  'reminders.rendered-content.v1' as const

export type ReminderSlotKind = 'morning' | 'day' | 'evening'

export type ReminderSlotTimes = {
  readonly morning: string | null
  readonly day: string | null
  readonly evening: string | null
}

export type SaveReminderSchedulePayload = ReminderSlotTimes & {
  readonly timeZone: typeof REMINDER_TIME_ZONE
}

export type SaveReminderScheduleApplicationCommand =
  ApplicationCommand<SaveReminderSchedulePayload>

export type ReminderCommandIdentity = {
  readonly actor: ActorRef
  readonly actorScope: string
  readonly commandType: string
  readonly commandId: string
  readonly occurredAt: Date
}

export type SaveReminderSchedulePersistenceInput = ReminderCommandIdentity & {
  readonly spaceId: string
  readonly memberId: string
  readonly expectedRevision?: bigint
  readonly slots: ReminderSlotTimes
}

export type ReminderSchedulePersistenceResult = {
  readonly scheduleId: string
  readonly revision: bigint
}

export type ClaimDueOccurrencesInput = {
  readonly now: Date
  readonly leaseOwner: string
  readonly limit: number
  readonly leaseDurationMs: number
}

export type ReminderOccurrenceClaim = {
  readonly occurrenceId: string
  readonly recipientMemberId: string
  readonly localDate: string
  readonly slotKind: ReminderSlotKind
  readonly dueAt: Date
  readonly expiresAt: Date
  readonly fencingToken: bigint
}

export type TransitionReminderOccurrenceClaimInput = {
  readonly occurrenceId: string
  readonly leaseOwner: string
  readonly fencingToken: bigint
  readonly nextState: 'cancelled' | 'expired'
  readonly now: Date
}

export type ReminderContentItemV1 = DomainReminderContentItem

export type ReminderRenderedContentV1 = DomainReminderRenderedContent

export type ReminderRelevanceSnapshot = {
  readonly read: TrackingTodayReadModelV1
  readonly localDate: string
  readonly localTime: string
}

export type ReminderIntentBuildResult =
  | {
      readonly kind: 'prepared'
      readonly occurrenceId: string
      readonly intentId: string
      readonly attemptId: string
      readonly intentRevision: bigint
      readonly contentHash: string
      readonly expiresAt: Date
    }
  | {
      readonly kind: 'suppressed'
      readonly occurrenceId: string
      readonly reason:
        'no_active_plan' | 'inactive_lifecycle' | 'nothing_relevant' | 'expired'
    }

export type PersistReminderIntentInput = {
  readonly claim: ReminderOccurrenceClaim
  readonly leaseOwner: string
  readonly now: Date
  readonly source: Extract<
    TrackingTodayReadModelV1,
    { readonly state: 'published' }
  > | null
  readonly content: ReminderRenderedContentV1 | null
  readonly suppressionReason:
    'no_active_plan' | 'inactive_lifecycle' | 'nothing_relevant' | 'expired'
}

export interface ReminderIntentPersistencePort {
  persistIntent(
    input: PersistReminderIntentInput,
  ): Promise<ReminderIntentBuildResult>
}

export type TelegramAttemptOutcome =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'retryable'
      readonly reason: 'rate_limited' | 'provider_error'
      readonly retryAfterSeconds: number | null
    }
  | {
      readonly kind: 'terminal'
      readonly reason:
        | 'blocked'
        | 'chat_not_found'
        | 'provider_rejected'
        | 'expired'
        | 'superseded'
    }
  | {
      readonly kind: 'ambiguous'
      readonly reason:
        | 'timeout'
        | 'aborted'
        | 'transport_error'
        | 'malformed_response'
        | 'oversized_response'
    }

export interface ReminderDeliveryTransportPort {
  send(input: {
    readonly chatId: bigint
    readonly text: string
    readonly signal: AbortSignal
  }): Promise<TelegramAttemptOutcome>
}

export type DeliverReminderInput = {
  readonly claim: ReminderOccurrenceClaim
  readonly leaseOwner: string
  readonly intentId: string
  readonly attemptId: string
  readonly signal: AbortSignal
}

export type DeliverReminderResult = {
  readonly attemptId: string
  readonly outcome: TelegramAttemptOutcome
}

export interface ReminderAttemptPersistencePort {
  inspectPrepared(input: {
    readonly attemptId: string
    readonly intentId: string
    readonly occurrenceId: string
    readonly leaseOwner: string
    readonly fencingToken: bigint
    readonly now: Date
  }): Promise<
    | {
        readonly kind: 'prepared'
        readonly intentId: string
        readonly recipientMemberId: string
        readonly content: ReminderRenderedContentV1
      }
    | { readonly kind: 'dispatching' }
    | { readonly kind: 'terminal'; readonly outcome: TelegramAttemptOutcome }
    | { readonly kind: 'stale' }
  >
  beginDispatch(input: {
    readonly attemptId: string
    readonly intentId: string
    readonly occurrenceId: string
    readonly leaseOwner: string
    readonly fencingToken: bigint
    readonly now: Date
  }): Promise<
    | {
        readonly kind: 'dispatch'
      }
    | { readonly kind: 'terminal'; readonly outcome: TelegramAttemptOutcome }
    | { readonly kind: 'stale' }
  >
  completePrepared(input: {
    readonly attemptId: string
    readonly occurrenceId: string
    readonly leaseOwner: string
    readonly fencingToken: bigint
    readonly now: Date
    readonly outcome: TelegramAttemptOutcome
  }): Promise<boolean>
  completeDispatch(input: {
    readonly attemptId: string
    readonly occurrenceId: string
    readonly leaseOwner: string
    readonly fencingToken: bigint
    readonly now: Date
    readonly outcome: TelegramAttemptOutcome
  }): Promise<boolean>
}

export interface ReminderTodayReadPort {
  getToday(memberId: string): Promise<TrackingTodayReadModelV1>
}

export interface ReminderSchedulePersistencePort {
  saveSchedule(
    input: SaveReminderSchedulePersistenceInput,
  ): Promise<ReminderSchedulePersistenceResult>
  claimDueOccurrences(
    input: ClaimDueOccurrencesInput,
  ): Promise<readonly ReminderOccurrenceClaim[]>
  transitionClaim(
    input: TransitionReminderOccurrenceClaimInput,
  ): Promise<boolean>
}

export type ReminderScheduleResult = DurableCommandResultRef<
  typeof REMINDER_SCHEDULE_RESULT_KIND
>

export function canonicalReminderSchedulePayload(
  payload: SaveReminderSchedulePayload,
): CanonicalJsonObject {
  return {
    timeZone: payload.timeZone,
    morning: payload.morning,
    day: payload.day,
    evening: payload.evening,
  }
}
