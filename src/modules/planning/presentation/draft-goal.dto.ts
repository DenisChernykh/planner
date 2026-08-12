import { Transform, Type } from 'class-transformer'
import {
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const POSITIVE = /^[1-9][0-9]*$/u
const MONTH = /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])$/u

export class DraftMonthQueryDto {
  @IsString()
  @Matches(MONTH)
  public readonly targetMonth!: string
}

export class PlanMonthPathDto {
  @IsString()
  @Matches(UUID)
  public readonly planMonthId!: string
}

export class DraftGoalPathDto extends PlanMonthPathDto {
  @IsString()
  @Matches(UUID)
  public readonly planGoalId!: string
}

class MutationDto {
  @IsString()
  @Matches(UUID)
  public readonly commandId!: string

  @IsString()
  @Matches(POSITIVE)
  public readonly expectedRevision!: string
}

export class SourceProvenanceDto {
  @IsIn([1])
  public readonly schemaVersion!: 1
  @IsString()
  @Matches(/\S/u)
  @MaxLength(500)
  public readonly sourceDocument!: string
  @IsInt()
  @Min(1)
  public readonly sourcePage!: number
  @IsDefined()
  @ValidateIf(
    (_object, value: unknown) => value !== null && value !== undefined,
  )
  @IsString()
  @MaxLength(2_000)
  public readonly rawValue!: string | null
  @IsDefined()
  @ValidateIf(
    (_object, value: unknown) => value !== null && value !== undefined,
  )
  @IsString()
  @MaxLength(2_000)
  public readonly rawDenominator!: string | null
  @IsString()
  @Matches(/\S/u)
  @MaxLength(500)
  public readonly resolution!: string
}

export class AddDraftGoalRequestDto extends MutationDto {
  @IsString()
  @Matches(UUID)
  public readonly goalDefinitionId!: string

  @IsObject()
  public readonly config!: Record<string, unknown>

  @IsDefined()
  @ValidateIf(
    (_object, value: unknown) => value !== null && value !== undefined,
  )
  @IsObject()
  @ValidateNested()
  @Type(() => SourceProvenanceDto)
  public readonly sourceProvenance!: SourceProvenanceDto | null
}

export class UpdateDraftGoalRequestDto extends MutationDto {
  @IsString()
  @Matches(UUID)
  public readonly goalDefinitionVersionId!: string

  @IsObject()
  public readonly config!: Record<string, unknown>

  @IsDefined()
  @ValidateIf(
    (_object, value: unknown) => value !== null && value !== undefined,
  )
  @IsObject()
  @ValidateNested()
  @Type(() => SourceProvenanceDto)
  public readonly sourceProvenance!: SourceProvenanceDto | null
}

export class RemoveDraftGoalRequestDto extends MutationDto {}

export class ReorderDraftGoalsRequestDto extends MutationDto {
  @IsArray()
  @Transform(({ value }: { value: unknown }) => value)
  @IsString({ each: true })
  @Matches(UUID, { each: true })
  public readonly orderedPlanGoalIds!: readonly string[]
}
