import { ApiProperty } from '@nestjs/swagger'
import { IsString, Matches, MaxLength } from 'class-validator'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const POSITIVE = /^[1-9][0-9]*$/u

export class ReopenMonthRequestDto {
  @ApiProperty({ type: String, pattern: UUID.source })
  @IsString()
  @Matches(UUID)
  public readonly commandId!: string

  @IsString()
  @Matches(POSITIVE)
  @ApiProperty({ type: String, pattern: POSITIVE.source })
  public readonly expectedRevision!: string

  @IsString()
  @Matches(/\S/u)
  @MaxLength(2_000)
  @ApiProperty({ type: String, minLength: 1, maxLength: 2_000 })
  public readonly reason!: string
}

export class PlanMonthMutationResponseDto {
  @ApiProperty({ enum: ['planning.plan-month.v1'] })
  public readonly kind!: 'planning.plan-month.v1'

  @ApiProperty({ type: String, pattern: UUID.source })
  public readonly aggregateId!: string

  @ApiProperty({ type: String, pattern: POSITIVE.source })
  public readonly aggregateRevision!: string
}
