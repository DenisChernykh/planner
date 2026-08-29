import { Type } from 'class-transformer'
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator'

export class MonthHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  public readonly limit?: number

  @IsOptional()
  @IsString()
  @Matches(/^[1-9][0-9]*$/u)
  public readonly cursor?: string
}
