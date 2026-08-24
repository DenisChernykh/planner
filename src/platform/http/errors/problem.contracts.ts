export interface ProblemFieldError {
  readonly pointer: string
  readonly code: string
  readonly detail: string
}

export interface ProblemDocument {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail: string
  readonly instance: string
  readonly code: string
  readonly requestId: string
  readonly errors?: readonly ProblemFieldError[]
  readonly conflict?: ProblemConflict
  readonly blockers?: readonly PublicationProblemBlocker[]
}

export type ProblemConflict =
  | GoalDefinitionProblemConflict
  | DraftProblemConflict
  | PublicationPreviewProblemConflict
  | AlreadyPublishedProblemConflict
  | TrackingFactTargetUnavailableProblemConflict
  | TrackingFactRevisionProblemConflict
  | TrackingFactUndoProblemConflict
  | TrackingExistingFactProblemConflict
  | TrackingCloseDayTargetProblemConflict
  | TrackingCloseDayRetryProblemConflict
  | TrackingExistingDayCloseProblemConflict
  | TrackingWeeklyTaskTargetProblemConflict
  | ReminderScheduleRevisionProblemConflict
  | PlanMonthRevisionProblemConflict
  | PlanMonthReopenProblemConflict
  | PlanMonthRecloseProblemConflict
  | PlanMonthAlreadyExistsProblemConflict

export interface TrackingFactTargetUnavailableProblemConflict {
  readonly reason:
    | 'not_active'
    | 'future_date'
    | 'not_applicable'
    | 'closed'
    | 'unsupported'
    | 'correction_required'
    | 'already_deleted'
}

export interface TrackingFactRevisionProblemConflict {
  readonly expectedRevision: string | null
  readonly currentRevision: string | null
}

export interface TrackingFactUndoProblemConflict {
  readonly reason: 'nothing_to_undo' | 'not_latest' | 'superseded'
  readonly nextAction: 'reload-tracking-state'
}

export interface TrackingExistingFactProblemConflict {
  readonly factRecordId: string
  readonly revision: string
  readonly nextAction: 'correct-existing-record'
}

export interface TrackingCloseDayTargetProblemConflict {
  readonly reason: 'not_active' | 'future_date' | 'not_applicable' | 'closed'
}

export interface TrackingCloseDayRetryProblemConflict {
  readonly expectedRevision?: string
  readonly currentRevision?: string
  readonly nextAction: 'reload-close-day-preview-and-retry'
}

export interface TrackingExistingDayCloseProblemConflict {
  readonly dayCloseId: string
  readonly revision: string
  readonly nextAction: 'open-closed-day'
}

export interface TrackingWeeklyTaskTargetProblemConflict {
  readonly reason:
    'not_active' | 'future_period' | 'preactivation' | 'stale_period' | 'closed'
}

export interface ReminderScheduleRevisionProblemConflict {
  readonly expectedRevision: string | null
  readonly currentRevision: string | null
  readonly nextAction: 'reload-reminder-settings-and-retry'
}

export interface PlanMonthRevisionProblemConflict {
  readonly expectedRevision: string
  readonly currentRevision: string
  readonly nextAction: 'reload-month-and-retry'
}

export interface PlanMonthReopenProblemConflict {
  readonly reason: 'not_closed' | 'already_reopened'
  readonly currentRevision: string
  readonly currentStatus: 'draft' | 'published' | 'grace' | 'closed'
  readonly nextAction: 'reload-month'
}

export interface PlanMonthRecloseProblemConflict {
  readonly currentRevision: string
  readonly currentStatus: 'draft' | 'published' | 'grace' | 'closed'
  readonly currentLifecycleMode: 'ordinary' | 'reopened'
  readonly nextAction: 'reload-month'
}

export interface PlanMonthAlreadyExistsProblemConflict {
  readonly existingRef: {
    readonly kind: 'planning.plan-draft.v1'
    readonly aggregateId: string
    readonly aggregateRevision: string
  }
  readonly nextAction: 'open-existing-month'
}

export interface PublicationPreviewProblemConflict {
  readonly currentDraftRevision: string
  readonly currentPreviewSchemaVersion: string
  readonly currentPreviewHashVersion: string
  readonly currentPreviewHash: string
  readonly nextAction: 'reload-publication-preview-and-retry'
}

export interface AlreadyPublishedProblemConflict {
  readonly publicationId: string
  readonly publicationRevision: string
  readonly nextAction: 'open-published-plan'
}

export interface PublicationProblemBlocker {
  readonly planGoalId: string | null
  readonly pointer: string
  readonly code: 'required' | 'empty_collection' | 'incompatible'
  readonly detail: string
}

export interface GoalDefinitionProblemConflict {
  readonly currentRevision: string
  readonly currentState: 'active' | 'archived'
  readonly nextAction: 'reload-goal-definition-and-retry'
}

export interface DraftProblemConflict {
  readonly expectedRevision: string
  readonly currentRevision: string
}

export interface ProblemDefinition {
  readonly slug: string
  readonly title: string
  readonly status: number
  readonly code: string
  readonly detail: string
}

export interface RegisteredProblemDefinition extends ProblemDefinition {
  readonly type: string
}

export interface HttpProblemMapping {
  readonly code: string
  readonly errors?: readonly ProblemFieldError[]
  readonly conflict?: ProblemConflict
  readonly blockers?: readonly PublicationProblemBlocker[]
}

export type HttpProblemMapper = (
  error: unknown,
) => HttpProblemMapping | undefined

export interface HttpProblemContribution {
  readonly definitions: readonly RegisteredProblemDefinition[]
  readonly mappedCodes: readonly string[]
  readonly map: HttpProblemMapper
}

export interface MappedHttpProblem {
  readonly definition: RegisteredProblemDefinition
  readonly errors?: readonly ProblemFieldError[]
  readonly conflict?: ProblemConflict
  readonly blockers?: readonly PublicationProblemBlocker[]
  readonly unexpected: boolean
}
