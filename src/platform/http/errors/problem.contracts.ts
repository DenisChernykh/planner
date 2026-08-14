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
