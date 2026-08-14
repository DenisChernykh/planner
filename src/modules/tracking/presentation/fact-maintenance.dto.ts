import { IsIn, IsObject, IsString, Matches, MaxLength } from 'class-validator'

import type { DurableCommandResultRef } from '@/shared/application/application-command'

import {
  CLOSE_DAY_PREVIEW_HASH_VERSION,
  CLOSE_DAY_PREVIEW_SCHEMA_VERSION,
  type CloseDayPreviewV1,
} from '../application/close-day.types'
import type { CorrectFactValueV1 } from '../application/tracking.types'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const POSITIVE = /^[1-9][0-9]*$/u
const NONNEGATIVE = /^(?:0|[1-9][0-9]*)$/u
const LOCAL_DATE = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/u
const SHA256 = /^[0-9a-f]{64}$/u

export class FactRecordPathDto {
  @IsString()
  @Matches(UUID)
  public readonly factRecordId!: string
}

export class CloseDayPathDto {
  @IsString()
  @Matches(UUID)
  public readonly publicationId!: string

  @IsString()
  @Matches(LOCAL_DATE)
  public readonly localDate!: string
}

export class WeeklyTaskPathDto {
  @IsString()
  @Matches(UUID)
  public readonly publicationId!: string

  @IsString()
  @Matches(UUID)
  public readonly flexiblePeriodId!: string
}

class FactMutationRequestDto {
  @IsString()
  @Matches(UUID)
  public readonly commandId!: string

  @IsString()
  @Matches(POSITIVE)
  public readonly expectedRevision!: string
}

export class CorrectFactRequestDto extends FactMutationRequestDto {
  @IsObject()
  public readonly value!: CorrectFactValueV1

  @IsString()
  @Matches(/\S/u)
  @MaxLength(2_000)
  public readonly reason!: string
}

export class DeleteFactRequestDto extends FactMutationRequestDto {
  @IsString()
  @Matches(/\S/u)
  @MaxLength(2_000)
  public readonly reason!: string
}

export class UndoFactRequestDto extends FactMutationRequestDto {}

export class CloseDayRequestDto {
  @IsString()
  @Matches(UUID)
  public readonly commandId!: string

  @IsString()
  @Matches(NONNEGATIVE)
  public readonly expectedRevision!: string

  @IsIn([CLOSE_DAY_PREVIEW_SCHEMA_VERSION])
  public readonly previewSchemaVersion!: typeof CLOSE_DAY_PREVIEW_SCHEMA_VERSION

  @IsIn([CLOSE_DAY_PREVIEW_HASH_VERSION])
  public readonly previewHashVersion!: typeof CLOSE_DAY_PREVIEW_HASH_VERSION

  @IsString()
  @Matches(SHA256)
  public readonly previewHash!: string
}

export class RecordWeeklyTaskResultRequestDto {
  @IsString()
  @Matches(UUID)
  public readonly commandId!: string

  @IsIn(['done', 'not_done'])
  public readonly result!: 'done' | 'not_done'
}

export type TrackingDayCloseMutationResponseV1 = {
  readonly kind: 'tracking.day-close.v1'
  readonly aggregateId: string
  readonly aggregateRevision: string
}

export function toTrackingDayCloseMutationResponse(
  value: DurableCommandResultRef<'tracking.day-close.v1'>,
): TrackingDayCloseMutationResponseV1 {
  if (value.aggregateRevision <= 0n) {
    throw new TypeError('Expected positive facts revision')
  }
  return Object.freeze({
    kind: value.kind,
    aggregateId: value.aggregateId,
    aggregateRevision: value.aggregateRevision.toString(10),
  })
}

export type CloseDayPreviewResponseV1 =
  | (Omit<CloseDayPreviewV1 & { readonly state: 'ready' }, 'factsRevision'> & {
      readonly factsRevision: string
    })
  | (Omit<
      CloseDayPreviewV1 & { readonly state: 'closed' },
      'revision' | 'closedAt'
    > & {
      readonly revision: string
      readonly closedAt: string
    })

export function toCloseDayPreviewResponse(
  value: CloseDayPreviewV1,
): CloseDayPreviewResponseV1 {
  if (value.state === 'ready') {
    return Object.freeze({
      ...value,
      factsRevision: value.factsRevision.toString(10),
      unresolved: Object.freeze(
        value.unresolved.map((item) => Object.freeze({ ...item })),
      ),
    })
  }
  return Object.freeze({
    ...value,
    revision: value.revision.toString(10),
    closedAt: value.closedAt.toISOString(),
  })
}
