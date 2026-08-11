export interface HealthHttpResult<T> {
  readonly statusCode: 200 | 503
  readonly body: T
}

export interface LivenessSnapshot {
  readonly status: 'ok'
}

export interface StartupSnapshot {
  readonly status: 'ok' | 'starting'
}

export interface ReadinessSnapshot {
  readonly status: 'ok' | 'unavailable'
}
