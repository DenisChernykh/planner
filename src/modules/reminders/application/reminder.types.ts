import type {
  ActorRef,
  ApplicationCommand,
  CanonicalJsonObject,
  DurableCommandResultRef,
} from '@/shared/application/application-command'

export const REMINDER_TIME_ZONE = 'Asia/Yekaterinburg' as const
export const REMINDER_SCHEDULE_RESULT_KIND = 'reminders.schedule.v1' as const

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
