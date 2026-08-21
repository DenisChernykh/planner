import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, Matches, ValidateIf } from 'class-validator'

import type { DurableCommandResultRef } from '@/shared/application/application-command'

import {
  REMINDER_TIME_ZONE,
  type ReminderDeliveryStatusReadModel,
  type ReminderSettingsReadModel,
  type ReminderSlotTimes,
} from '../application/reminder.types'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const POSITIVE = /^[1-9][0-9]*$/u
const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u

export class SaveReminderSettingsRequestDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsString()
  @Matches(UUID)
  public readonly commandId!: string

  @ApiPropertyOptional({ type: String, pattern: '^[1-9][0-9]*$' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(POSITIVE)
  public readonly expectedRevision?: string

  @ApiProperty({ enum: [REMINDER_TIME_ZONE] })
  @IsString()
  public readonly timeZone!: typeof REMINDER_TIME_ZONE

  @ApiProperty({ type: String, nullable: true, pattern: TIME.source })
  @IsOptional()
  @IsString()
  @Matches(TIME)
  public readonly morning!: string | null

  @ApiProperty({ type: String, nullable: true, pattern: TIME.source })
  @IsOptional()
  @IsString()
  @Matches(TIME)
  public readonly day!: string | null

  @ApiProperty({ type: String, nullable: true, pattern: TIME.source })
  @IsOptional()
  @IsString()
  @Matches(TIME)
  public readonly evening!: string | null
}

export type ReminderScheduleMutationResponseV1 = {
  readonly kind: 'reminders.schedule.v1'
  readonly aggregateId: string
  readonly aggregateRevision: string
}

export function toReminderScheduleMutationResponse(
  value: DurableCommandResultRef<'reminders.schedule.v1'>,
): ReminderScheduleMutationResponseV1 {
  if (value.aggregateRevision <= 0n) {
    throw new TypeError('Expected positive reminder schedule revision')
  }
  return Object.freeze({
    kind: value.kind,
    aggregateId: value.aggregateId,
    aggregateRevision: value.aggregateRevision.toString(10),
  })
}

export type ReminderSettingsResponseV1 = {
  readonly schemaVersion: 'reminders.settings.v1'
  readonly scheduleId: string | null
  readonly revision: string | null
  readonly timeZone: typeof REMINDER_TIME_ZONE
  readonly morning: string | null
  readonly day: string | null
  readonly evening: string | null
}

export function toReminderSettingsResponse(
  value: ReminderSettingsReadModel & {
    readonly schemaVersion: 'reminders.settings.v1'
  },
): ReminderSettingsResponseV1 {
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    scheduleId: value.scheduleId,
    revision: value.revision?.toString(10) ?? null,
    timeZone: value.timeZone,
    ...value.slots,
  })
}

export type ReminderDeliveryStatusResponseV1 = {
  readonly schemaVersion: 'reminders.delivery-status.v1'
  readonly status: ReminderDeliveryStatusReadModel['status']
}

export function toReminderDeliveryStatusResponse(
  value: ReminderDeliveryStatusReadModel & {
    readonly schemaVersion: 'reminders.delivery-status.v1'
  },
): ReminderDeliveryStatusResponseV1 {
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    status: value.status,
  })
}

export function reminderSlots(
  body: SaveReminderSettingsRequestDto,
): ReminderSlotTimes {
  return {
    morning: body.morning,
    day: body.day,
    evening: body.evening,
  }
}
