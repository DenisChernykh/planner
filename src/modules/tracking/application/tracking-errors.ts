export class TrackingAuthorizationDeniedError extends Error {
  public constructor() {
    super('Tracking operation is not authorized')
    this.name = 'TrackingAuthorizationDeniedError'
  }
}

export class TrackingQueryValidationError extends Error {
  public constructor() {
    super('Tracking query is invalid')
    this.name = 'TrackingQueryValidationError'
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

export type ExistingFactRef = {
  readonly factRecordId: string
  readonly revision: bigint
}

export class FactCorrectionRequiredError extends Error {
  public constructor(public readonly existingRef: ExistingFactRef) {
    super('Existing fact must be changed through the correction command')
    this.name = 'FactCorrectionRequiredError'
  }
}

export class WeeklyTaskTargetNotFoundError extends Error {
  public constructor() {
    super('Weekly planned task target was not found')
    this.name = 'WeeklyTaskTargetNotFoundError'
  }
}

export type WeeklyTaskTargetUnavailableReason =
  'not_active' | 'future_period' | 'preactivation' | 'stale_period' | 'closed'

export class WeeklyTaskTargetUnavailableError extends Error {
  public constructor(
    public readonly reason: WeeklyTaskTargetUnavailableReason,
  ) {
    super(`Weekly planned task target is unavailable: ${reason}`)
    this.name = 'WeeklyTaskTargetUnavailableError'
  }
}

export class WeeklyTaskAlreadySystemClosedError extends Error {
  public constructor(public readonly existingRef: ExistingFactRef) {
    super('Weekly planned task was already closed by the system')
    this.name = 'WeeklyTaskAlreadySystemClosedError'
  }
}

export type FactUndoUnavailableReason =
  'nothing_to_undo' | 'not_latest' | 'superseded'

export class FactUndoUnavailableError extends Error {
  public constructor(public readonly reason: FactUndoUnavailableReason) {
    super(`Fact undo is unavailable: ${reason}`)
    this.name = 'FactUndoUnavailableError'
  }
}

export class TrackingDependencyUnavailableError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Tracking dependency is unavailable', options)
    this.name = 'TrackingDependencyUnavailableError'
  }
}

export class CloseDayTargetNotFoundError extends Error {
  public constructor() {
    super('CloseDay target was not found')
    this.name = 'CloseDayTargetNotFoundError'
  }
}

export type CloseDayTargetUnavailableReason =
  'not_active' | 'future_date' | 'not_applicable' | 'closed'

export class CloseDayTargetUnavailableError extends Error {
  public constructor(public readonly reason: CloseDayTargetUnavailableReason) {
    super(`CloseDay target is unavailable: ${reason}`)
    this.name = 'CloseDayTargetUnavailableError'
  }
}

export class CloseDayRevisionConflictError extends Error {
  public constructor(
    public readonly expectedRevision: bigint,
    public readonly currentRevision: bigint,
  ) {
    super('CloseDay facts revision is stale')
    this.name = 'CloseDayRevisionConflictError'
  }
}

export class CloseDayPreviewConflictError extends Error {
  public constructor() {
    super('CloseDay preview no longer matches the unresolved set')
    this.name = 'CloseDayPreviewConflictError'
  }
}

export type ExistingDayCloseRef = {
  readonly dayCloseId: string
  readonly revision: bigint
}

export class CloseDayAlreadyClosedError extends Error {
  public constructor(public readonly existingRef: ExistingDayCloseRef) {
    super('Day was already closed by this member')
    this.name = 'CloseDayAlreadyClosedError'
  }
}
