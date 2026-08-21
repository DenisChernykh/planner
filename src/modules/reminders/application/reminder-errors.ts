export class ReminderScheduleRevisionConflictError extends Error {
  public constructor(
    public readonly expectedRevision: bigint | null = null,
    public readonly currentRevision: bigint | null = null,
  ) {
    super('Reminder schedule revision is stale')
    this.name = 'ReminderScheduleRevisionConflictError'
  }
}

export class ReminderAuthorizationDeniedError extends Error {
  public constructor() {
    super('Reminder schedule access is denied')
    this.name = 'ReminderAuthorizationDeniedError'
  }
}

export class ReminderDependencyUnavailableError extends Error {
  public constructor(options?: { readonly cause?: unknown }) {
    super('Reminder dependency is unavailable', options)
    this.name = 'ReminderDependencyUnavailableError'
  }
}

export class ReminderClaimValidationError extends Error {
  public constructor() {
    super('Reminder claim options are invalid')
    this.name = 'ReminderClaimValidationError'
  }
}

export class ReminderIntentClaimStaleError extends Error {
  public constructor() {
    super('Reminder occurrence claim is stale or expired')
    this.name = 'ReminderIntentClaimStaleError'
  }
}

export class ReminderIntentDependencyUnavailableError extends Error {
  public constructor(options?: { readonly cause?: unknown }) {
    super('Reminder intent dependency is unavailable', options)
    this.name = 'ReminderIntentDependencyUnavailableError'
  }
}
