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

export class PlanMonthRevisionConflictResponseDto {
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', example: '1' })
  public readonly expectedRevision!: string

  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', example: '2' })
  public readonly currentRevision!: string

  @ApiProperty({ enum: ['reload-month-and-retry'] })
  public readonly nextAction!: 'reload-month-and-retry'
}

export class PlanMonthRevisionConflictProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({ enum: ['PLAN_MONTH_REVISION_CONFLICT'] })
  declare public readonly code: 'PLAN_MONTH_REVISION_CONFLICT'

  @ApiProperty({ type: () => PlanMonthRevisionConflictResponseDto })
  public readonly conflict!: PlanMonthRevisionConflictResponseDto
}

export class PlanMonthReopenConflictResponseDto {
  @ApiProperty({ enum: ['not_closed', 'already_reopened'] })
  public readonly reason!: 'not_closed' | 'already_reopened'

  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', example: '3' })
  public readonly currentRevision!: string

  @ApiProperty({ enum: ['draft', 'published', 'grace', 'closed'] })
  public readonly currentStatus!: 'draft' | 'published' | 'grace' | 'closed'

  @ApiProperty({ enum: ['reload-month'] })
  public readonly nextAction!: 'reload-month'
}

export class PlanMonthReopenConflictProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({ enum: ['PLAN_MONTH_REOPEN_CONFLICT'] })
  declare public readonly code: 'PLAN_MONTH_REOPEN_CONFLICT'

  @ApiProperty({ type: () => PlanMonthReopenConflictResponseDto })
  public readonly conflict!: PlanMonthReopenConflictResponseDto
}

export class PlanMonthRecloseConflictResponseDto {
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', example: '4' })
  public readonly currentRevision!: string

  @ApiProperty({ enum: ['draft', 'published', 'grace', 'closed'] })
  public readonly currentStatus!: 'draft' | 'published' | 'grace' | 'closed'

  @ApiProperty({ enum: ['ordinary', 'reopened'] })
  public readonly currentLifecycleMode!: 'ordinary' | 'reopened'

  @ApiProperty({ enum: ['reload-month'] })
  public readonly nextAction!: 'reload-month'
}

export class PlanMonthRecloseConflictProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({ enum: ['PLAN_MONTH_RECLOSE_CONFLICT'] })
  declare public readonly code: 'PLAN_MONTH_RECLOSE_CONFLICT'

  @ApiProperty({ type: () => PlanMonthRecloseConflictResponseDto })
  public readonly conflict!: PlanMonthRecloseConflictResponseDto
}

export class ReminderScheduleRevisionConflictResponseDto {
  @ApiProperty({
    type: String,
    pattern: '^[1-9][0-9]*$',
    nullable: true,
  })
  public readonly expectedRevision!: string | null

  @ApiProperty({
    type: String,
    pattern: '^[1-9][0-9]*$',
    nullable: true,
  })
  public readonly currentRevision!: string | null

  @ApiProperty({ enum: ['reload-reminder-settings-and-retry'] })
  public readonly nextAction!: 'reload-reminder-settings-and-retry'
}

export class ReminderScheduleRevisionConflictProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: ['REMINDER_SCHEDULE_REVISION_CONFLICT'],
    example: 'REMINDER_SCHEDULE_REVISION_CONFLICT',
  })
  declare public readonly code: 'REMINDER_SCHEDULE_REVISION_CONFLICT'

  @ApiProperty({ type: () => ReminderScheduleRevisionConflictResponseDto })
  public readonly conflict!: ReminderScheduleRevisionConflictResponseDto
}

export class TrackingFactTargetUnavailableConflictResponseDto {
  @ApiProperty({
    enum: [
      'not_active',
      'future_date',
      'not_applicable',
      'closed',
      'unsupported',
      'correction_required',
      'already_deleted',
    ],
  })
  public readonly reason!:
    | 'not_active'
    | 'future_date'
    | 'not_applicable'
    | 'closed'
    | 'unsupported'
    | 'correction_required'
    | 'already_deleted'
}

export class TrackingFactTargetUnavailableProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: ['TRACKING_FACT_TARGET_UNAVAILABLE'],
    example: 'TRACKING_FACT_TARGET_UNAVAILABLE',
  })
  declare public readonly code: 'TRACKING_FACT_TARGET_UNAVAILABLE'

  @ApiProperty({ type: () => TrackingFactTargetUnavailableConflictResponseDto })
  public readonly conflict!: TrackingFactTargetUnavailableConflictResponseDto
}

export class TrackingFactRevisionConflictResponseDto {
  @ApiProperty({
    type: String,
    pattern: '^[1-9][0-9]*$',
    nullable: true,
  })
  public readonly expectedRevision!: string | null

  @ApiProperty({
    type: String,
    pattern: '^[1-9][0-9]*$',
    nullable: true,
  })
  public readonly currentRevision!: string | null
}

export class TrackingFactRevisionProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: ['TRACKING_FACT_REVISION_CONFLICT'],
    example: 'TRACKING_FACT_REVISION_CONFLICT',
  })
  declare public readonly code: 'TRACKING_FACT_REVISION_CONFLICT'

  @ApiProperty({ type: () => TrackingFactRevisionConflictResponseDto })
  public readonly conflict!: TrackingFactRevisionConflictResponseDto
}

export class TrackingFactUndoConflictResponseDto {
  @ApiProperty({ enum: ['nothing_to_undo', 'not_latest', 'superseded'] })
  public readonly reason!: 'nothing_to_undo' | 'not_latest' | 'superseded'

  @ApiProperty({ enum: ['reload-tracking-state'] })
  public readonly nextAction!: 'reload-tracking-state'
}

export class TrackingFactUndoProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: ['TRACKING_FACT_UNDO_UNAVAILABLE'],
    example: 'TRACKING_FACT_UNDO_UNAVAILABLE',
  })
  declare public readonly code: 'TRACKING_FACT_UNDO_UNAVAILABLE'

  @ApiProperty({ type: () => TrackingFactUndoConflictResponseDto })
  public readonly conflict!: TrackingFactUndoConflictResponseDto
}

export class TrackingExistingFactConflictResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  public readonly factRecordId!: string

  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$' })
  public readonly revision!: string

  @ApiProperty({ enum: ['correct-existing-record'] })
  public readonly nextAction!: 'correct-existing-record'
}

export class TrackingExistingFactProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: [
      'TRACKING_FACT_CORRECTION_REQUIRED',
      'TRACKING_WEEKLY_TASK_ALREADY_SYSTEM_CLOSED',
    ],
    example: 'TRACKING_FACT_CORRECTION_REQUIRED',
  })
  declare public readonly code:
    | 'TRACKING_FACT_CORRECTION_REQUIRED'
    | 'TRACKING_WEEKLY_TASK_ALREADY_SYSTEM_CLOSED'

  @ApiProperty({ type: () => TrackingExistingFactConflictResponseDto })
  public readonly conflict!: TrackingExistingFactConflictResponseDto
}

export class TrackingCloseDayTargetConflictResponseDto {
  @ApiProperty({
    enum: ['not_active', 'future_date', 'not_applicable', 'closed'],
  })
  public readonly reason!:
    'not_active' | 'future_date' | 'not_applicable' | 'closed'
}

export class TrackingCloseDayTargetProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: ['TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE'],
    example: 'TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE',
  })
  declare public readonly code: 'TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE'

  @ApiProperty({ type: () => TrackingCloseDayTargetConflictResponseDto })
  public readonly conflict!: TrackingCloseDayTargetConflictResponseDto
}

export class TrackingCloseDayRetryConflictResponseDto {
  @ApiProperty({
    type: String,
    pattern: '^(?:0|[1-9][0-9]*)$',
    required: false,
  })
  public readonly expectedRevision?: string

  @ApiProperty({
    type: String,
    pattern: '^(?:0|[1-9][0-9]*)$',
    required: false,
  })
  public readonly currentRevision?: string

  @ApiProperty({ enum: ['reload-close-day-preview-and-retry'] })
  public readonly nextAction!: 'reload-close-day-preview-and-retry'
}

export class TrackingCloseDayRetryProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: [
      'TRACKING_CLOSE_DAY_REVISION_CONFLICT',
      'TRACKING_CLOSE_DAY_PREVIEW_CONFLICT',
    ],
    example: 'TRACKING_CLOSE_DAY_REVISION_CONFLICT',
  })
  declare public readonly code:
    | 'TRACKING_CLOSE_DAY_REVISION_CONFLICT'
    | 'TRACKING_CLOSE_DAY_PREVIEW_CONFLICT'

  @ApiProperty({ type: () => TrackingCloseDayRetryConflictResponseDto })
  public readonly conflict!: TrackingCloseDayRetryConflictResponseDto
}

export class TrackingExistingDayCloseConflictResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  public readonly dayCloseId!: string

  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$' })
  public readonly revision!: string

  @ApiProperty({ enum: ['open-closed-day'] })
  public readonly nextAction!: 'open-closed-day'
}

export class TrackingExistingDayCloseProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: ['TRACKING_CLOSE_DAY_ALREADY_CLOSED'],
    example: 'TRACKING_CLOSE_DAY_ALREADY_CLOSED',
  })
  declare public readonly code: 'TRACKING_CLOSE_DAY_ALREADY_CLOSED'

  @ApiProperty({ type: () => TrackingExistingDayCloseConflictResponseDto })
  public readonly conflict!: TrackingExistingDayCloseConflictResponseDto
}

export class TrackingWeeklyTaskTargetConflictResponseDto {
  @ApiProperty({
    enum: [
      'not_active',
      'future_period',
      'preactivation',
      'stale_period',
      'closed',
    ],
  })
  public readonly reason!:
    'not_active' | 'future_period' | 'preactivation' | 'stale_period' | 'closed'
}

export class TrackingWeeklyTaskTargetProblemResponseDto extends ProblemResponseDto {
  @ApiProperty({
    enum: ['TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE'],
    example: 'TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE',
  })
  declare public readonly code: 'TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE'

  @ApiProperty({ type: () => TrackingWeeklyTaskTargetConflictResponseDto })
  public readonly conflict!: TrackingWeeklyTaskTargetConflictResponseDto
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
  @ApiProperty({ enum: ['VALIDATION_FAILED'], example: 'VALIDATION_FAILED' })
  declare public readonly code: 'VALIDATION_FAILED'

  @ApiProperty({ type: () => [ProblemFieldErrorResponseDto] })
  public readonly errors!: readonly ProblemFieldErrorResponseDto[]
}
