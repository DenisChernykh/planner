import { randomUUID } from 'node:crypto'

import { Prisma } from '@/generated/prisma/client'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import { ReminderScheduleRevisionConflictError } from '../application/reminder-errors'
import type {
  ClaimDueOccurrencesInput,
  ReminderOccurrenceClaim,
  ReminderSchedulePersistencePort,
  ReminderSchedulePersistenceResult,
  ReminderSlotKind,
  ReminderSlotTimes,
  SaveReminderSchedulePersistenceInput,
  TransitionReminderOccurrenceClaimInput,
} from '../application/reminder.types'

type Client = Parameters<Parameters<PrismaClientProvider['withClient']>[0]>[0]

type ScheduleRow = {
  readonly id: string
  readonly revision: bigint
  readonly morning: string | null
  readonly day_slot: string | null
  readonly evening: string | null
}

type SlotRow = {
  readonly id: string
  readonly schedule_id: string
  readonly slot_kind: ReminderSlotKind
  readonly local_time: string | null
  readonly next_due_at: Date | null
}

type OccurrenceRow = {
  readonly id: string
  readonly recipient_member_id: string
  readonly local_date: string
  readonly slot_kind: ReminderSlotKind
  readonly due_at: Date
  readonly expires_at: Date
  readonly fencing_token: bigint
}

const TIME_ZONE = 'Asia/Yekaterinburg'
const UTC_OFFSET_MS = 5 * 60 * 60 * 1_000
const SLOT_KINDS: readonly ReminderSlotKind[] = ['morning', 'day', 'evening']

function sqlTime(value: string | null): Prisma.Sql {
  return Prisma.sql`${value}::time`
}

function sqlBigInt(value: bigint | null): Prisma.Sql {
  return value === null ? Prisma.sql`NULL` : Prisma.sql`${value}`
}

function localDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value)
}

function nextDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + 1)
  return parsed.toISOString().slice(0, 10)
}

function instantFor(date: string, time: string): Date {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number)
  const [hour = 0, minute = 0] = time.split(':').map(Number)
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - UTC_OFFSET_MS)
}

function localDateFromInstant(value: Date): string {
  return localDate(value)
}

function expiryFor(
  date: string,
  slotKind: ReminderSlotKind,
  slots: ReminderSlotTimes,
): Date {
  const enabled = SLOT_KINDS.flatMap((kind) => {
    const time = slots[kind]
    return time === null ? [] : [{ kind, time }]
  })
  const index = enabled.findIndex((slot) => slot.kind === slotKind)
  const next = index >= 0 ? enabled[index + 1] : undefined
  return next === undefined
    ? instantFor(nextDate(date), '00:00')
    : instantFor(date, next.time)
}

function timeFor(
  slots: ReminderSlotTimes,
  kind: ReminderSlotKind,
): string | null {
  return slots[kind]
}

function slotsFromRows(
  rows: readonly { slot_kind: ReminderSlotKind; local_time: string | null }[],
): ReminderSlotTimes {
  const values: Record<ReminderSlotKind, string | null> = {
    morning: null,
    day: null,
    evening: null,
  }
  for (const row of rows)
    values[row.slot_kind] = row.local_time?.slice(0, 5) ?? null
  return values
}

function occurrenceState(expiresAt: Date, now: Date): 'pending' | 'expired' {
  return expiresAt <= now ? 'expired' : 'pending'
}

async function closeOrphanedDispatchingAttempts(
  client: Client,
  now: Date,
): Promise<void> {
  const ledger = await client.$queryRaw<{ readonly relation: string | null }[]>(
    Prisma.sql`SELECT to_regclass('notification_attempts')::text AS relation`,
  )
  if (ledger[0]?.relation === null) return
  await client.$executeRaw(
    Prisma.sql`UPDATE notification_attempts attempt
                  SET state = 'terminal', outcome = 'ambiguous',
                      outcome_reason = 'transport_error',
                      completed_at = ${now}, updated_at = ${now}
                 FROM reminder_occurrences occurrence
                WHERE attempt.occurrence_id = occurrence.id
                  AND attempt.state = 'dispatching'
                  AND (
                    occurrence.state <> 'claimed'
                    OR occurrence.lease_until <= ${now}
                    OR occurrence.expires_at <= ${now}
                  )`,
  )
}

async function upsertOccurrence(
  client: Client,
  input: {
    readonly spaceId: string
    readonly memberId: string
    readonly scheduleId: string
    readonly scheduleRevision: bigint
    readonly date: string
    readonly kind: ReminderSlotKind
    readonly slots: ReminderSlotTimes
    readonly now: Date
    readonly preservePastExisting: boolean
    readonly deferPastNewOccurrence: boolean
  },
): Promise<void> {
  const time = timeFor(input.slots, input.kind)
  if (time === null) return
  const dueAt = instantFor(input.date, time)
  const expiresAt = expiryFor(input.date, input.kind, input.slots)
  const existing = await client.$queryRaw<
    { state: string; due_at: Date; expires_at: Date; fencing_token: bigint }[]
  >(
    Prisma.sql`SELECT state, due_at, expires_at, fencing_token
                 FROM reminder_occurrences
                WHERE recipient_member_id = ${input.memberId}::uuid
                  AND local_date = ${input.date}::date
                  AND slot_kind = ${input.kind}
                FOR UPDATE`,
  )
  const current = existing[0]
  if (
    current === undefined &&
    input.deferPastNewOccurrence &&
    input.date === localDate(input.now) &&
    dueAt <= input.now
  ) {
    return
  }
  if (current !== undefined) {
    const preserveCurrentDue =
      input.preservePastExisting &&
      input.date === localDate(input.now) &&
      (current.due_at <= input.now || dueAt <= input.now)
    if (preserveCurrentDue) {
      const active = current.state === 'pending' || current.state === 'claimed'
      const preserveCurrentWindow =
        (current.due_at > input.now && dueAt <= input.now) ||
        (current.expires_at > input.now && expiresAt <= input.now)
      const effectiveExpiresAt = preserveCurrentWindow
        ? current.expires_at
        : expiresAt
      const nextState = active
        ? occurrenceState(effectiveExpiresAt, input.now)
        : current.state
      const resetLease = current.state === 'claimed'
      await client.$executeRaw(
        Prisma.sql`UPDATE reminder_occurrences
                      SET schedule_id = ${input.scheduleId}::uuid,
                          schedule_revision = ${input.scheduleRevision},
                          due_at = ${current.due_at},
                          expires_at = ${effectiveExpiresAt},
                          state = ${nextState},
                          lease_owner = NULL,
                          lease_until = NULL,
                          fencing_token = fencing_token + ${resetLease ? 1n : 0n},
                          updated_at = ${input.now}
                    WHERE recipient_member_id = ${input.memberId}::uuid
                      AND local_date = ${input.date}::date
                      AND slot_kind = ${input.kind}`,
      )
      return
    }
    const resetLease = current.state === 'claimed'
    await client.$executeRaw(
      Prisma.sql`UPDATE reminder_occurrences
                    SET schedule_id = ${input.scheduleId}::uuid,
                        schedule_revision = ${input.scheduleRevision},
                        due_at = ${dueAt},
                        expires_at = ${expiresAt},
                        state = ${occurrenceState(expiresAt, input.now)},
                        lease_owner = NULL,
                        lease_until = NULL,
                        fencing_token = fencing_token + ${resetLease ? 1n : 0n},
                        updated_at = ${input.now}
                  WHERE recipient_member_id = ${input.memberId}::uuid
                    AND local_date = ${input.date}::date
                    AND slot_kind = ${input.kind}`,
    )
    return
  }
  await client.$executeRaw(
    Prisma.sql`INSERT INTO reminder_occurrences
      (id, space_id, recipient_member_id, schedule_id, local_date, slot_kind,
       schedule_revision, due_at, expires_at, state, fencing_token,
       created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${input.spaceId}::uuid,
              ${input.memberId}::uuid, ${input.scheduleId}::uuid,
              ${input.date}::date, ${input.kind}, ${input.scheduleRevision},
              ${dueAt}, ${expiresAt},
              ${occurrenceState(expiresAt, input.now)},
              0, ${input.now}, ${input.now})`,
  )
}

async function ensureSlotNextDueAt(
  client: Client,
  slot: {
    readonly id: string
    readonly scheduleId: string
    readonly kind: ReminderSlotKind
  },
  schedule: ReminderSchedulePersistenceResult & {
    readonly slots: ReminderSlotTimes
  },
  now: Date,
): Promise<void> {
  const future = await client.$queryRaw<{ due_at: Date }[]>(
    Prisma.sql`SELECT due_at
                 FROM reminder_occurrences
                WHERE schedule_id = ${slot.scheduleId}::uuid
                  AND slot_kind = ${slot.kind}
                  AND state IN ('pending', 'claimed')
                  AND due_at > ${now}
                ORDER BY due_at ASC
                LIMIT 1`,
  )
  const nextDueAt =
    future[0]?.due_at ??
    instantFor(nextDate(localDate(now)), slotTime(schedule.slots, slot.kind)!)
  await client.$executeRaw(
    Prisma.sql`UPDATE reminder_schedule_slots
                  SET next_due_at = ${nextDueAt}, updated_at = ${now}
                WHERE id = ${slot.id}::uuid`,
  )
}

function slotTime(
  slots: ReminderSlotTimes,
  kind: ReminderSlotKind,
): string | null {
  return slots[kind]
}

export class PrismaReminderSchedulePersistence implements ReminderSchedulePersistencePort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public async saveSchedule(
    input: SaveReminderSchedulePersistenceInput,
  ): Promise<ReminderSchedulePersistenceResult> {
    return this.database.withClient(async (client) => {
      await client.$queryRaw(
        Prisma.sql`SELECT id FROM memberships
                    WHERE id = ${input.memberId}::uuid
                      AND space_id = ${input.spaceId}::uuid
                    FOR UPDATE`,
      )
      const rows = await client.$queryRaw<ScheduleRow[]>(
        Prisma.sql`SELECT schedule.id,
                          schedule.revision,
                          max(slot.local_time) FILTER (WHERE slot.slot_kind = 'morning')::text morning,
                          max(slot.local_time) FILTER (WHERE slot.slot_kind = 'day')::text day_slot,
                          max(slot.local_time) FILTER (WHERE slot.slot_kind = 'evening')::text evening
                     FROM reminder_schedules schedule
                LEFT JOIN reminder_schedule_slots slot
                       ON slot.schedule_id = schedule.id
                    WHERE schedule.member_id = ${input.memberId}::uuid
                      AND schedule.space_id = ${input.spaceId}::uuid
                 GROUP BY schedule.id, schedule.revision`,
      )
      const existing = rows[0]
      if (
        existing !== undefined &&
        (input.expectedRevision === undefined ||
          input.expectedRevision !== existing.revision)
      ) {
        throw new ReminderScheduleRevisionConflictError(
          input.expectedRevision ?? null,
          existing.revision,
        )
      }
      if (existing === undefined && input.expectedRevision !== undefined) {
        throw new ReminderScheduleRevisionConflictError(
          input.expectedRevision,
          null,
        )
      }

      const scheduleId = existing?.id ?? randomUUID()
      const revision = existing === undefined ? 1n : existing.revision + 1n
      const oldSlots: ReminderSlotTimes =
        existing === undefined
          ? { morning: null, day: null, evening: null }
          : {
              morning: existing.morning?.slice(0, 5) ?? null,
              day: existing.day_slot?.slice(0, 5) ?? null,
              evening: existing.evening?.slice(0, 5) ?? null,
            }
      const now = input.occurredAt
      if (existing === undefined) {
        await client.$executeRaw(
          Prisma.sql`INSERT INTO reminder_schedules
            (id, space_id, member_id, revision, time_zone, created_at, updated_at)
            VALUES (${scheduleId}::uuid, ${input.spaceId}::uuid,
                    ${input.memberId}::uuid, 1, ${TIME_ZONE}, ${now}, ${now})`,
        )
      } else {
        await client.$executeRaw(
          Prisma.sql`UPDATE reminder_schedules
                        SET revision = ${revision}, updated_at = ${now}
                      WHERE id = ${scheduleId}::uuid`,
        )
      }

      const currentDate = localDate(now)
      const tomorrow = nextDate(currentDate)
      for (const kind of SLOT_KINDS) {
        const configuredTime = input.slots[kind]
        const nextDueAt =
          configuredTime === null
            ? null
            : instantFor(currentDate, configuredTime) > now
              ? instantFor(currentDate, configuredTime)
              : instantFor(tomorrow, configuredTime)
        await client.$executeRaw(
          Prisma.sql`INSERT INTO reminder_schedule_slots
            (id, schedule_id, slot_kind, local_time, next_due_at, created_at, updated_at)
            VALUES (${randomUUID()}::uuid, ${scheduleId}::uuid, ${kind},
                    ${sqlTime(input.slots[kind])}, ${nextDueAt}, ${now}, ${now})
            ON CONFLICT (schedule_id, slot_kind) DO UPDATE
              SET local_time = EXCLUDED.local_time,
                  next_due_at = EXCLUDED.next_due_at,
                  updated_at = EXCLUDED.updated_at`,
        )
        if (input.slots[kind] === null) {
          await client.$executeRaw(
            Prisma.sql`UPDATE reminder_occurrences
                          SET state = 'cancelled', lease_owner = NULL,
                              lease_until = NULL, fencing_token = fencing_token + 1,
                              schedule_revision = ${revision}, updated_at = ${now}
                        WHERE schedule_id = ${scheduleId}::uuid
                          AND slot_kind = ${kind}
                          AND state IN ('pending', 'claimed')`,
          )
        } else {
          await upsertOccurrence(client, {
            spaceId: input.spaceId,
            memberId: input.memberId,
            scheduleId,
            scheduleRevision: revision,
            date: currentDate,
            kind,
            slots: input.slots,
            now,
            preservePastExisting: existing !== undefined,
            deferPastNewOccurrence: true,
          })
          await upsertOccurrence(client, {
            spaceId: input.spaceId,
            memberId: input.memberId,
            scheduleId,
            scheduleRevision: revision,
            date: tomorrow,
            kind,
            slots: input.slots,
            now,
            preservePastExisting: false,
            deferPastNewOccurrence: false,
          })
        }
      }

      await client.$executeRaw(
        Prisma.sql`INSERT INTO reminder_schedule_changes
          (action_id, schedule_id, space_id, member_id, actor_scope, command_type,
           command_id, before_revision, after_revision, before_morning, before_day,
           before_evening, after_morning, after_day, after_evening, occurred_at)
          VALUES (${randomUUID()}::uuid, ${scheduleId}::uuid,
                  ${input.spaceId}::uuid, ${input.memberId}::uuid,
                  ${input.actorScope}, ${input.commandType},
                  ${input.commandId}::uuid, ${sqlBigInt(existing?.revision ?? null)},
                  ${revision}, ${sqlTime(oldSlots.morning)}, ${sqlTime(oldSlots.day)},
                  ${sqlTime(oldSlots.evening)}, ${sqlTime(input.slots.morning)},
                  ${sqlTime(input.slots.day)}, ${sqlTime(input.slots.evening)},
                  ${now})`,
      )
      return { scheduleId, revision }
    })
  }

  public async claimDueOccurrences(
    input: ClaimDueOccurrencesInput,
  ): Promise<readonly ReminderOccurrenceClaim[]> {
    return this.database.withClient(async (client) => {
      await client.$executeRaw(
        Prisma.sql`UPDATE reminder_occurrences
                      SET state = 'expired', lease_owner = NULL,
                          lease_until = NULL, updated_at = ${input.now}
                    WHERE state IN ('pending', 'claimed')
                      AND expires_at <= ${input.now}`,
      )
      await client.$executeRaw(
        Prisma.sql`UPDATE reminder_occurrences
                      SET state = 'pending', lease_owner = NULL,
                          lease_until = NULL, fencing_token = fencing_token + 1,
                          updated_at = ${input.now}
                    WHERE state = 'claimed'
                      AND lease_until <= ${input.now}
                      AND expires_at > ${input.now}`,
      )
      await closeOrphanedDispatchingAttempts(client, input.now)
      await client.$executeRaw(
        Prisma.sql`UPDATE reminder_occurrences occurrence
                      SET state = 'terminal', updated_at = ${input.now}
                    WHERE occurrence.state = 'pending'
                      AND EXISTS (
                        SELECT 1
                          FROM notification_attempts attempt
                         WHERE attempt.occurrence_id = occurrence.id
                           AND attempt.state = 'terminal'
                           AND attempt.outcome IN ('accepted', 'terminal', 'ambiguous')
                      )`,
      )

      const due = await client.$queryRaw<SlotRow[]>(
        Prisma.sql`SELECT slot.id, slot.schedule_id, slot.slot_kind,
                          slot.local_time, slot.next_due_at
                     FROM reminder_schedule_slots slot
                    WHERE slot.local_time IS NOT NULL
                      AND slot.next_due_at IS NOT NULL
                      AND slot.next_due_at <= ${input.now}
                 ORDER BY slot.next_due_at ASC, slot.id ASC
                    FOR UPDATE SKIP LOCKED`,
      )
      const scheduleCache = new Map<string, ReminderSlotTimes>()
      for (const slot of due) {
        let slots = scheduleCache.get(slot.schedule_id)
        if (slots === undefined) {
          const rows = await client.$queryRaw<
            { slot_kind: ReminderSlotKind; local_time: string | null }[]
          >(
            Prisma.sql`SELECT slot_kind, local_time::text local_time
                         FROM reminder_schedule_slots
                        WHERE schedule_id = ${slot.schedule_id}::uuid`,
          )
          slots = slotsFromRows(rows)
          scheduleCache.set(slot.schedule_id, slots)
        }
        const schedule = await client.$queryRaw<
          { id: string; revision: bigint }[]
        >(
          Prisma.sql`SELECT id, revision FROM reminder_schedules WHERE id = ${slot.schedule_id}::uuid`,
        )
        const scheduleRow = schedule[0]
        if (scheduleRow === undefined || slot.local_time === null) continue
        const candidate =
          localDateFromInstant(slot.next_due_at!) < localDate(input.now)
            ? localDate(input.now)
            : localDateFromInstant(slot.next_due_at!)
        const member = await client.$queryRaw<
          { space_id: string; member_id: string }[]
        >(
          Prisma.sql`SELECT space_id, member_id FROM reminder_schedules WHERE id = ${slot.schedule_id}::uuid`,
        )
        const memberRow = member[0]
        if (memberRow === undefined) continue
        await upsertOccurrence(client, {
          spaceId: memberRow.space_id,
          memberId: memberRow.member_id,
          scheduleId: slot.schedule_id,
          scheduleRevision: scheduleRow.revision,
          date: candidate,
          kind: slot.slot_kind,
          slots,
          now: input.now,
          preservePastExisting: true,
          deferPastNewOccurrence: false,
        })
        await ensureSlotNextDueAt(
          client,
          { id: slot.id, scheduleId: slot.schedule_id, kind: slot.slot_kind },
          {
            scheduleId: slot.schedule_id,
            revision: scheduleRow.revision,
            slots,
          },
          input.now,
        )
      }

      const claimed = await client.$queryRaw<OccurrenceRow[]>(
        Prisma.sql`WITH candidates AS (
          SELECT id
            FROM reminder_occurrences
           WHERE state = 'pending'
             AND due_at <= ${input.now}
             AND expires_at > ${input.now}
             AND (
               NOT EXISTS (
                 SELECT 1
                   FROM notification_attempts attempt
                  WHERE attempt.occurrence_id = reminder_occurrences.id
               )
               OR EXISTS (
                 SELECT 1
                   FROM notification_attempts attempt
                  WHERE attempt.id = (
                    SELECT latest.id
                      FROM notification_attempts latest
                     WHERE latest.occurrence_id = reminder_occurrences.id
                     ORDER BY latest.created_at DESC, latest.id DESC
                     LIMIT 1
                   )
                    AND (
                      attempt.state = 'prepared'
                      OR (
                        attempt.state = 'terminal'
                        AND attempt.outcome = 'retryable'
                        AND attempt.next_attempt_at IS NOT NULL
                        AND attempt.next_attempt_at <= ${input.now}
                      )
                    )
               )
             )
           ORDER BY due_at ASC, id ASC
           LIMIT ${input.limit}
           FOR UPDATE SKIP LOCKED
        )
        UPDATE reminder_occurrences occurrence
           SET state = 'claimed', lease_owner = ${input.leaseOwner},
               lease_until = ${new Date(input.now.getTime() + input.leaseDurationMs)},
               fencing_token = occurrence.fencing_token + 1,
               updated_at = ${input.now}
          FROM candidates
         WHERE occurrence.id = candidates.id
        RETURNING occurrence.id, occurrence.recipient_member_id,
                  occurrence.local_date::text local_date, occurrence.slot_kind,
                  occurrence.due_at, occurrence.expires_at,
                  occurrence.fencing_token`,
      )
      for (const slot of due) {
        const rows = await client.$queryRaw<
          { schedule_id: string; revision: bigint }[]
        >(
          Prisma.sql`SELECT schedule_id, schedule_revision revision
                       FROM reminder_occurrences
                      WHERE schedule_id = ${slot.schedule_id}::uuid
                        AND slot_kind = ${slot.slot_kind}
                   ORDER BY schedule_revision DESC
                      LIMIT 1`,
        )
        const revision = rows[0]?.revision
        if (revision === undefined) continue
        const scheduleRows = await client.$queryRaw<
          { slot_kind: ReminderSlotKind; local_time: string | null }[]
        >(
          Prisma.sql`SELECT slot_kind, local_time::text local_time
                       FROM reminder_schedule_slots
                      WHERE schedule_id = ${slot.schedule_id}::uuid`,
        )
        const slots = slotsFromRows(scheduleRows)
        await ensureSlotNextDueAt(
          client,
          { id: slot.id, scheduleId: slot.schedule_id, kind: slot.slot_kind },
          { scheduleId: slot.schedule_id, revision, slots },
          input.now,
        )
      }
      return claimed.map((row) => ({
        occurrenceId: row.id,
        recipientMemberId: row.recipient_member_id,
        localDate: row.local_date,
        slotKind: row.slot_kind,
        dueAt: new Date(row.due_at.getTime()),
        expiresAt: new Date(row.expires_at.getTime()),
        fencingToken: row.fencing_token,
      }))
    })
  }

  public async transitionClaim(
    input: TransitionReminderOccurrenceClaimInput,
  ): Promise<boolean> {
    const changed = await this.database.withClient((client) =>
      client.$executeRaw(
        Prisma.sql`UPDATE reminder_occurrences
                      SET state = ${input.nextState}, lease_owner = NULL,
                          lease_until = NULL, updated_at = ${input.now}
                    WHERE id = ${input.occurrenceId}::uuid
                      AND state = 'claimed'
                      AND lease_owner = ${input.leaseOwner}
                      AND fencing_token = ${input.fencingToken}
                      AND lease_until > ${input.now}
                      AND (
                        (${input.nextState} = 'expired' AND expires_at <= ${input.now})
                        OR (${input.nextState} IN ('cancelled', 'terminal') AND expires_at > ${input.now})
                      )`,
      ),
    )
    return changed === 1
  }
}
