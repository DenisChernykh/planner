import { IsIn, IsObject, IsString, Matches, ValidateIf } from 'class-validator'

import type {
  RecordCompositeOccurrenceComponentV1,
  RecordChecklistItemPayload,
  RecordOrVariantPayload,
  RecordTextPayload,
} from '../application/tracking.types'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const LOCAL_DATE = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/u
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u

class CompositeTargetRequestDto {
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

class FixedCompositeTargetRequestDto extends CompositeTargetRequestDto {
  @IsString()
  @Matches(LOCAL_DATE)
  public readonly expectationDate!: string

  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @Matches(UUID)
  public readonly checkpointId!: string | null
}

export class RecordTextRequestDto extends FixedCompositeTargetRequestDto {
  @IsString()
  public readonly text!: string

  @IsIn(['done', 'not_done'])
  public readonly result!: RecordTextPayload['result']
}

export class RecordChecklistItemRequestDto extends FixedCompositeTargetRequestDto {
  @IsString()
  @Matches(UUID)
  public readonly checklistItemId!: string

  @IsIn(['done', 'not_done'])
  public readonly state!: RecordChecklistItemPayload['state']
}

export class RecordOrVariantRequestDto extends FixedCompositeTargetRequestDto {
  @IsString()
  @Matches(UUID)
  public readonly variantId!: string

  @IsString()
  @Matches(DECIMAL)
  public readonly value!: RecordOrVariantPayload['value']
}

export class RecordCompositeOccurrenceRequestDto extends CompositeTargetRequestDto {
  @IsString()
  @Matches(LOCAL_DATE)
  public readonly localDate!: string

  @IsObject()
  public readonly component!: RecordCompositeOccurrenceComponentV1
}
