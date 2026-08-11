export interface DatabaseLifecycle {
  connect(signal: AbortSignal): Promise<void>
  close(signal: AbortSignal): Promise<void>
}

export interface DatabaseReadinessProbe {
  check(signal: AbortSignal): Promise<'up' | 'down'>
}

export class DatabaseUnavailableError extends Error {
  public constructor() {
    super('Database is unavailable')
    this.name = 'DatabaseUnavailableError'
  }
}
