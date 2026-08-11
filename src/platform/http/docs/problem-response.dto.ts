import { ApiProperty } from '@nestjs/swagger'

import { PROBLEM_CATALOG } from '@/platform/http/errors/problem-registry'

const problemCodes = PROBLEM_CATALOG.map(({ code }) => code)

export class ProblemFieldErrorResponseDto {
  @ApiProperty({
    type: String,
    pattern: '^(?:|(?:/(?:[^~/]|~[01])*)+)$',
    example: '/profile/name~1with~0reserved',
  })
  public readonly pointer!: string

  @ApiProperty({
    type: String,
    pattern: '^[a-z][a-z0-9_]*$',
    example: 'invalid_value',
  })
  public readonly code!: string

  @ApiProperty({ type: String, example: 'Field has an invalid value.' })
  public readonly detail!: string
}

export class ProblemConflictResponseDto {
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', example: '2' })
  public readonly currentRevision!: string

  @ApiProperty({ enum: ['active', 'archived'] })
  public readonly currentState!: 'active' | 'archived'

  @ApiProperty({ enum: ['reload-goal-definition-and-retry'] })
  public readonly nextAction!: 'reload-goal-definition-and-retry'
}

export class ProblemResponseDto {
  @ApiProperty({
    type: String,
    format: 'uri',
    example: 'https://planner.invalid/problems/internal-error',
  })
  public readonly type!: string

  @ApiProperty({ type: String, example: 'Internal server error' })
  public readonly title!: string

  @ApiProperty({ type: Number, minimum: 400, maximum: 599, example: 500 })
  public readonly status!: number

  @ApiProperty({
    type: String,
    example: 'The server could not complete the request.',
  })
  public readonly detail!: string

  @ApiProperty({
    type: String,
    format: 'uri-reference',
    example: 'urn:request:01ARZ3NDEKTSV4RRFFQ69G5FAV',
  })
  public readonly instance!: string

  @ApiProperty({
    type: String,
    enum: problemCodes,
    example: 'INTERNAL_ERROR',
  })
  public readonly code!: string

  @ApiProperty({
    type: String,
    example: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  })
  public readonly requestId!: string
}

export class GoalDefinitionConflictProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: [
      'GOAL_DEFINITION_REVISION_CONFLICT',
      'GOAL_DEFINITION_STATE_CONFLICT',
    ],
    example: 'GOAL_DEFINITION_REVISION_CONFLICT',
  })
  declare public readonly code:
    'GOAL_DEFINITION_REVISION_CONFLICT' | 'GOAL_DEFINITION_STATE_CONFLICT'

  @ApiProperty({ type: () => ProblemConflictResponseDto })
  public readonly conflict!: ProblemConflictResponseDto
}

export class ValidationProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({ type: () => [ProblemFieldErrorResponseDto] })
  public readonly errors!: readonly ProblemFieldErrorResponseDto[]
}
