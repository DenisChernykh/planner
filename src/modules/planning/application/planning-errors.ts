import type { DurableCommandResultRef } from '@/shared/application/application-command'

import type { PublicationPreviewBlocker } from './publication-preview'

export class PlanningAuthorizationDeniedError extends Error {
  public constructor() {
    super('Planning operation is not authorized')
    this.name = 'PlanningAuthorizationDeniedError'
  }
}

export class PlanMonthAlreadyExistsError extends Error {
  public constructor(
    public readonly existingRef: DurableCommandResultRef<'planning.plan-draft.v1'>,
  ) {
    super('A plan month already exists for this space and month')
    this.name = 'PlanMonthAlreadyExistsError'
  }
}

export class PlanDraftNotFoundError extends Error {
  public constructor() {
    super('Plan draft was not found')
    this.name = 'PlanDraftNotFoundError'
  }
}

export class PlanDraftNotEditableError extends Error {
  public constructor() {
    super('Plan draft is not editable')
    this.name = 'PlanDraftNotEditableError'
  }
}

export class DraftRevisionConflictError extends Error {
  public constructor(
    public readonly expectedRevision: bigint,
    public readonly currentRevision: bigint,
  ) {
    super('Plan draft revision conflicts with the expected revision')
    this.name = 'DraftRevisionConflictError'
  }
}

export class PlanningDependencyUnavailableError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Planning dependency is unavailable', options)
    this.name = 'PlanningDependencyUnavailableError'
  }
}

export class GoalDefinitionNotFoundError extends Error {
  public constructor() {
    super('Goal definition was not found')
    this.name = 'GoalDefinitionNotFoundError'
  }
}

export class GoalDefinitionRevisionConflictError extends Error {
  public constructor(
    public readonly expectedRevision: bigint,
    public readonly currentRevision: bigint,
    public readonly currentState: 'active' | 'archived',
  ) {
    super('Goal definition revision conflicts with the expected revision')
    this.name = 'GoalDefinitionRevisionConflictError'
  }
}

export class GoalDefinitionStateConflictError extends Error {
  public constructor(
    public readonly requestedState: 'active' | 'archived',
    public readonly currentState: 'active' | 'archived',
    public readonly currentRevision: bigint,
  ) {
    super('Goal definition state conflicts with the requested state')
    this.name = 'GoalDefinitionStateConflictError'
  }
}

export class DraftGoalNotFoundError extends Error {
  public constructor() {
    super('Draft goal was not found')
    this.name = 'DraftGoalNotFoundError'
  }
}

export class GoalDefinitionVersionNotFoundError extends Error {
  public constructor() {
    super('Goal definition version was not found')
    this.name = 'GoalDefinitionVersionNotFoundError'
  }
}

export class PublicationPreviewConflictError extends Error {
  public constructor(
    public readonly currentDraftRevision: bigint,
    public readonly currentPreviewSchemaVersion: string,
    public readonly currentPreviewHashVersion: string,
    public readonly currentPreviewHash: string,
  ) {
    super('Publication preview no longer matches the draft')
    this.name = 'PublicationPreviewConflictError'
  }
}

export class PlanPublicationBlockedError extends Error {
  public constructor(
    public readonly blockers: readonly PublicationPreviewBlocker[],
  ) {
    super('Plan publication is blocked')
    this.name = 'PlanPublicationBlockedError'
  }
}

export class PlanMonthAlreadyPublishedError extends Error {
  public constructor(
    public readonly publicationId: string,
    public readonly publicationRevision: bigint,
  ) {
    super('Plan month is already published')
    this.name = 'PlanMonthAlreadyPublishedError'
  }
}

export class PlanPublicationNotFoundError extends Error {
  public constructor() {
    super('Plan publication was not found')
    this.name = 'PlanPublicationNotFoundError'
  }
}

export class PlanMonthRevisionConflictError extends Error {
  public constructor(
    public readonly expectedRevision: bigint,
    public readonly currentRevision: bigint,
  ) {
    super('Plan month revision conflicts with the expected revision')
    this.name = 'PlanMonthRevisionConflictError'
  }
}

export type PlanPublicationCancellationConflictReason =
  'not_active' | 'month_started' | 'facts_exist'

export class PlanPublicationCancellationConflictError extends Error {
  public constructor(
    public readonly reason: PlanPublicationCancellationConflictReason,
    public readonly currentRevision: bigint,
  ) {
    super(`Plan publication cannot be cancelled: ${reason}`)
    this.name = 'PlanPublicationCancellationConflictError'
  }
}

export class PlanPublicationModeConflictError extends Error {
  public constructor(
    public readonly requiredMode: 'publish' | 'republish',
    public readonly latestPublicationRevision: bigint | null,
  ) {
    super(`Plan month requires ${requiredMode}`)
    this.name = 'PlanPublicationModeConflictError'
  }
}

export class ActivePlanMonthNotFoundError extends Error {
  public constructor() {
    super('Active plan month was not found')
    this.name = 'ActivePlanMonthNotFoundError'
  }
}
