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

export class DraftProblemConflictResponseDto {
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', example: '1' })
  public readonly expectedRevision!: string

  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', example: '2' })
  public readonly currentRevision!: string
}

export class DraftConflictProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: ['DRAFT_REVISION_CONFLICT'],
    example: 'DRAFT_REVISION_CONFLICT',
  })
  declare public readonly code: 'DRAFT_REVISION_CONFLICT'

  @ApiProperty({ type: () => DraftProblemConflictResponseDto })
  public readonly conflict!: DraftProblemConflictResponseDto
}

export class PublicationPreviewConflictResponseDto {
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$' })
  public readonly currentDraftRevision!: string
  @ApiProperty({ type: String })
  public readonly currentPreviewSchemaVersion!: string
  @ApiProperty({ type: String })
  public readonly currentPreviewHashVersion!: string
  @ApiProperty({ type: String, pattern: '^[0-9a-f]{64}$' })
  public readonly currentPreviewHash!: string
  @ApiProperty({ enum: ['reload-publication-preview-and-retry'] })
  public readonly nextAction!: 'reload-publication-preview-and-retry'
}

export class PublicationPreviewConflictProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: ['PUBLICATION_PREVIEW_CONFLICT'],
    example: 'PUBLICATION_PREVIEW_CONFLICT',
  })
  declare public readonly code: 'PUBLICATION_PREVIEW_CONFLICT'
  @ApiProperty({ type: () => PublicationPreviewConflictResponseDto })
  public readonly conflict!: PublicationPreviewConflictResponseDto
}

export class AlreadyPublishedConflictResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  public readonly publicationId!: string
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$' })
  public readonly publicationRevision!: string
  @ApiProperty({ enum: ['open-published-plan'] })
  public readonly nextAction!: 'open-published-plan'
}

export class PlanMonthAlreadyPublishedProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: ['PLAN_MONTH_ALREADY_PUBLISHED'],
    example: 'PLAN_MONTH_ALREADY_PUBLISHED',
  })
  declare public readonly code: 'PLAN_MONTH_ALREADY_PUBLISHED'
  @ApiProperty({ type: () => AlreadyPublishedConflictResponseDto })
  public readonly conflict!: AlreadyPublishedConflictResponseDto
}

export class PublicationBlockerResponseDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  public readonly planGoalId!: string | null
  @ApiProperty({ type: String })
  public readonly pointer!: string
  @ApiProperty({ enum: ['required', 'empty_collection', 'incompatible'] })
  public readonly code!: 'required' | 'empty_collection' | 'incompatible'
  @ApiProperty({
    enum: [
      'Required value is missing.',
      'At least one item is required.',
      'Values are incompatible.',
      'due date is outside target month',
      'week ordinal is not present in target month',
      'Target month is not current or next.',
      'Publication materialization exceeds 10000 rows.',
    ],
  })
  public readonly detail!:
    | 'Required value is missing.'
    | 'At least one item is required.'
    | 'Values are incompatible.'
    | 'due date is outside target month'
    | 'week ordinal is not present in target month'
    | 'Target month is not current or next.'
    | 'Publication materialization exceeds 10000 rows.'
}

export class PlanPublicationBlockedProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: ['PLAN_PUBLICATION_BLOCKED'],
    example: 'PLAN_PUBLICATION_BLOCKED',
  })
  declare public readonly code: 'PLAN_PUBLICATION_BLOCKED'
  @ApiProperty({ type: () => [PublicationBlockerResponseDto] })
  public readonly blockers!: readonly PublicationBlockerResponseDto[]
}

export class ValidationProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({ type: () => [ProblemFieldErrorResponseDto] })
  public readonly errors!: readonly ProblemFieldErrorResponseDto[]
}
