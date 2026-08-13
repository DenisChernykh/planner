export class TrackingAuthorizationDeniedError extends Error {
  public constructor() {
    super('Tracking operation is not authorized')
    this.name = 'TrackingAuthorizationDeniedError'
  }
}

export class FactTargetNotFoundError extends Error {
  public constructor() {
    super('Fact target was not found')
    this.name = 'FactTargetNotFoundError'
  }
}

export type FactTargetUnavailableReason =
  | 'not_active'
  | 'future_date'
  | 'not_applicable'
  | 'closed'
  | 'unsupported'
  | 'correction_required'
  | 'already_deleted'

export class FactTargetUnavailableError extends Error {
  public constructor(public readonly reason: FactTargetUnavailableReason) {
    super(`Fact target is unavailable: ${reason}`)
    this.name = 'FactTargetUnavailableError'
  }
}

export class FactValueInvalidError extends Error {
  public constructor() {
    super('Fact value does not match the published target')
    this.name = 'FactValueInvalidError'
  }
}

export class FactRevisionConflictError extends Error {
  public constructor(
    public readonly expectedRevision: bigint | null,
    public readonly currentRevision: bigint | null,
  ) {
    super('Fact revision conflicts with the current state')
    this.name = 'FactRevisionConflictError'
  }
}

export class TrackingDependencyUnavailableError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Tracking dependency is unavailable', options)
    this.name = 'TrackingDependencyUnavailableError'
  }
}
