export class PilotReportInputError extends Error {
  public constructor() {
    super('Invalid pilot report input')
    this.name = 'PilotReportInputError'
  }
}

export class PilotReportSourceNotFoundError extends Error {
  public constructor() {
    super('Pilot report source was not found')
    this.name = 'PilotReportSourceNotFoundError'
  }
}

export class PilotReportSourceInvalidError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Pilot report source is invalid', options)
    this.name = 'PilotReportSourceInvalidError'
  }
}

export class PilotReportSourceChangedError extends Error {
  public constructor() {
    super('Pilot report source changed during calculation')
    this.name = 'PilotReportSourceChangedError'
  }
}

export class PilotReportDependencyUnavailableError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Pilot report dependency is unavailable', options)
    this.name = 'PilotReportDependencyUnavailableError'
  }
}
