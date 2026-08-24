import { Type } from 'class-transformer'
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

const CURSOR = /^v1\.[A-Za-z0-9_-]+$/u

export class ListPlanMonthsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  public readonly limit?: number

  @IsOptional()
  @IsString()
  @Matches(CURSOR)
  @MaxLength(300)
  public readonly cursor?: string
}
