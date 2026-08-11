import type { DurableCommandResultRef } from '@/shared/application/application-command'

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
