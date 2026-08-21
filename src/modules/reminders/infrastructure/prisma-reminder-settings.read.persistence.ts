import { Prisma } from '@/generated/prisma/client'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  ReminderDeliveryStatus,
  ReminderSettingsReadInput,
  ReminderSettingsReadModel,
  ReminderSettingsReadPort,
  ReminderSlotTimes,
} from '../application/reminder.types'
import { REMINDER_TIME_ZONE } from '../application/reminder.types'

type SettingsRow = {
  readonly id: string
  readonly revision: bigint
  readonly time_zone: string
  readonly morning: string | null
  readonly day_slot: string | null
  readonly evening: string | null
}

type AttemptRow = {
  readonly outcome: string | null
  readonly outcome_reason: string | null
}

function slots(row: SettingsRow | undefined): ReminderSlotTimes {
  return {
    morning: row?.morning?.slice(0, 5) ?? null,
    day: row?.day_slot?.slice(0, 5) ?? null,
    evening: row?.evening?.slice(0, 5) ?? null,
  }
}

export function projectReminderDeliveryStatus(
  input:
    | {
        readonly outcome: string | null
        readonly outcome_reason: string | null
      }
    | undefined,
): ReminderDeliveryStatus {
  const row = input
  if (row === undefined || row.outcome === 'accepted') return 'available'
  if (
    row.outcome === 'terminal' &&
    (row.outcome_reason === 'blocked' ||
      row.outcome_reason === 'chat_not_found')
  ) {
    return 'blocked'
  }
  if (
    row.outcome === 'retryable' ||
    row.outcome === 'ambiguous' ||
    (row.outcome === 'terminal' && row.outcome_reason === 'provider_rejected')
  ) {
    return 'connection_lost'
  }
  return 'available'
}

export class PrismaReminderSettingsReadPersistence implements ReminderSettingsReadPort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public async getSettings(
    input: ReminderSettingsReadInput,
  ): Promise<ReminderSettingsReadModel> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<SettingsRow[]>(
        Prisma.sql`SELECT schedule.id,
                          schedule.revision,
                          schedule.time_zone,
                          max(slot.local_time) FILTER (WHERE slot.slot_kind = 'morning')::text AS morning,
                          max(slot.local_time) FILTER (WHERE slot.slot_kind = 'day')::text AS day_slot,
                          max(slot.local_time) FILTER (WHERE slot.slot_kind = 'evening')::text AS evening
                     FROM reminder_schedules schedule
                LEFT JOIN reminder_schedule_slots slot
                       ON slot.schedule_id = schedule.id
                    WHERE schedule.space_id = ${input.spaceId}::uuid
                      AND schedule.member_id = ${input.memberId}::uuid
                 GROUP BY schedule.id, schedule.revision, schedule.time_zone`,
      )
      const row = rows[0]
      if (row === undefined) {
        return Object.freeze({
          scheduleId: null,
          revision: null,
          timeZone: REMINDER_TIME_ZONE,
          slots: slots(undefined),
        })
      }
      if (row.time_zone !== REMINDER_TIME_ZONE) {
        throw new Error('Reminder schedule has an unsupported time zone')
      }
      return Object.freeze({
        scheduleId: row.id,
        revision: row.revision,
        timeZone: REMINDER_TIME_ZONE,
        slots: slots(row),
      })
    })
  }

  public async getDeliveryStatus(
    input: ReminderSettingsReadInput,
  ): Promise<{ readonly status: ReminderDeliveryStatus }> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<AttemptRow[]>(
        Prisma.sql`SELECT attempt.outcome, attempt.outcome_reason
                     FROM notification_attempts attempt
                    WHERE attempt.space_id = ${input.spaceId}::uuid
                      AND attempt.recipient_member_id = ${input.memberId}::uuid
                      AND attempt.state = 'terminal'
                      AND attempt.outcome IS NOT NULL
                      AND NOT (
                        attempt.outcome = 'terminal'
                        AND attempt.outcome_reason IN ('expired', 'superseded')
                      )
                 ORDER BY attempt.completed_at DESC NULLS LAST, attempt.id DESC
                    LIMIT 1`,
      )
      return Object.freeze({ status: projectReminderDeliveryStatus(rows[0]) })
    })
  }
}
