import { ApiProperty } from '@nestjs/swagger'
import {
  IsInt,
  IsObject,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator'

import type { DurableCommandResultRef } from '@/shared/application/application-command'

import type {
  RecordCheckpointValueV1,
  RecordFactValueV1,
} from '../application/tracking.types'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const POSITIVE = /^[1-9][0-9]*$/u
const LOCAL_DATE = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/u
const LOCAL_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u

class ScalarTargetRequestDto {
  @IsString()
  @Matches(UUID)
  public readonly commandId!: string

  @IsString()
  @Matches(UUID)
  public readonly publicationId!: string

  @IsString()
  @Matches(UUID)
  public readonly planGoalSnapshotId!: string
}

export class RecordFactRequestDto extends ScalarTargetRequestDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(POSITIVE)
  public readonly expectedRevision?: string

  @IsString()
  @Matches(LOCAL_DATE)
  public readonly localDate!: string

  @IsObject()
  public readonly value!: RecordFactValueV1
}

export class RecordTimeRequestDto extends ScalarTargetRequestDto {
  @IsString()
  @Matches(LOCAL_DATE)
  public readonly expectationDate!: string

  @IsString()
  @Matches(LOCAL_TIME)
  public readonly value!: string
}

export class RecordRatingRequestDto extends ScalarTargetRequestDto {
  @IsString()
  @Matches(LOCAL_DATE)
  public readonly expectationDate!: string

  @IsInt()
  @Min(Number.MIN_SAFE_INTEGER)
  @Max(Number.MAX_SAFE_INTEGER)
  public readonly value!: number
}

export class RecordCheckpointRequestDto extends ScalarTargetRequestDto {
  @IsString()
  @Matches(LOCAL_DATE)
  public readonly expectationDate!: string

  @IsString()
  @Matches(UUID)
  public readonly checkpointId!: string

  @IsObject()
  public readonly value!: RecordCheckpointValueV1
}

export class TrackingFactMutationResponseV1Dto {
  @ApiProperty({ enum: ['tracking.fact-record.v1'] })
  public readonly kind!: 'tracking.fact-record.v1'

  @ApiProperty({ type: String, format: 'uuid' })
  public readonly aggregateId!: string

  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$' })
  public readonly aggregateRevision!: string
}

export type TrackingFactMutationResponseV1 = {
  readonly kind: 'tracking.fact-record.v1'
  readonly aggregateId: string
  readonly aggregateRevision: string
}

export function toTrackingFactMutationResponse(
  value: DurableCommandResultRef<'tracking.fact-record.v1'>,
): TrackingFactMutationResponseV1 {
  if (value.aggregateRevision <= 0n) {
    throw new TypeError('Expected positive fact revision')
  }
  return Object.freeze({
    kind: value.kind,
    aggregateId: value.aggregateId,
    aggregateRevision: value.aggregateRevision.toString(10),
  })
}
