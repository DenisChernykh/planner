export class ReminderScheduleRevisionConflictError extends Error {
  public constructor() {
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
