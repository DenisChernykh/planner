import { ApiProperty } from '@nestjs/swagger'
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator'

const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const positiveDecimal = /^[1-9][0-9]*$/u
const nonWhitespace = /\S/u

export class GoalDefinitionPathDto {
  @ApiProperty({ type: String, pattern: canonicalUuid.source })
  @IsString()
  @Matches(canonicalUuid)
  public readonly goalDefinitionId!: string
}

export class ListGoalDefinitionsQueryDto {
  @ApiProperty({ required: false, enum: ['active', 'archived', 'all'] })
  @IsOptional()
  @IsIn(['active', 'archived', 'all'])
  public readonly state?: 'active' | 'archived' | 'all'
}

class CommandIdDto {
  @ApiProperty({ type: String, pattern: canonicalUuid.source })
  @IsString()
  @Matches(canonicalUuid)
  public readonly commandId!: string
}

class MetadataDto extends CommandIdDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 200 })
  @IsString()
  @Matches(nonWhitespace)
  @MaxLength(200)
  public readonly title!: string

  @ApiProperty({ type: String, minLength: 1, maxLength: 2_000 })
  @IsString()
  @Matches(nonWhitespace)
  @MaxLength(2_000)
  public readonly why!: string

  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  @IsString()
  @Matches(nonWhitespace)
  @MaxLength(100)
  public readonly category!: string
}

class RevisionDto extends CommandIdDto {
  @ApiProperty({ type: String, pattern: positiveDecimal.source })
  @IsString()
  @Matches(positiveDecimal)
  public readonly expectedRevision!: string
}

export class CreateGoalDefinitionRequestDto extends MetadataDto {}

export class CreateGoalDefinitionVersionRequestDto extends MetadataDto {
  @ApiProperty({ type: String, pattern: positiveDecimal.source })
  @IsString()
  @Matches(positiveDecimal)
  public readonly expectedRevision!: string

  @ApiProperty({ enum: ['continue', 'new'] })
  @IsIn(['continue', 'new'])
  public readonly seriesDecision!: 'continue' | 'new'
}

export class GoalDefinitionStateRequestDto extends RevisionDto {}
export class CopyGoalDefinitionRequestDto extends RevisionDto {}

export class GoalDefinitionResultResponseDto {
  @ApiProperty({ enum: ['planning.goal-definition.v1'] })
  public readonly kind!: 'planning.goal-definition.v1'

  @ApiProperty({ type: String, pattern: canonicalUuid.source })
  public readonly aggregateId!: string

  @ApiProperty({ type: String, pattern: positiveDecimal.source })
  public readonly aggregateRevision!: string
}

export class GoalDefinitionVersionResponseDto {
  @ApiProperty({ type: String, pattern: canonicalUuid.source })
  public readonly goalDefinitionVersionId!: string

  @ApiProperty({ type: String, pattern: positiveDecimal.source })
  public readonly versionNumber!: string

  @ApiProperty({ type: String, pattern: canonicalUuid.source })
  public readonly goalSeriesId!: string

  @ApiProperty({ enum: ['continue', 'new'] })
  public readonly seriesDecision!: 'continue' | 'new'

  @ApiProperty({ type: String, minLength: 1, maxLength: 200 })
  public readonly title!: string

  @ApiProperty({ type: String, minLength: 1, maxLength: 2_000 })
  public readonly why!: string

  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  public readonly category!: string
}

export class GoalDefinitionSummaryResponseDto {
  @ApiProperty({ type: String, pattern: canonicalUuid.source })
  public readonly goalDefinitionId!: string

  @ApiProperty({ enum: ['active', 'archived'] })
  public readonly state!: 'active' | 'archived'

  @ApiProperty({ type: String, pattern: positiveDecimal.source })
  public readonly revision!: string

  @ApiProperty({ type: () => GoalDefinitionVersionResponseDto })
  public readonly currentVersion!: GoalDefinitionVersionResponseDto
}

export class GoalDefinitionDetailResponseDto extends GoalDefinitionSummaryResponseDto {
  @ApiProperty({ type: () => [GoalDefinitionVersionResponseDto] })
  public readonly versions!: readonly GoalDefinitionVersionResponseDto[]
}
