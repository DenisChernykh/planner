export type RuntimeEnvironment = 'development' | 'test' | 'production'

export interface DatabaseRuntimeConfig {
  readonly url: string
  readonly poolMax: number
  readonly connectionTimeoutMs: number
  readonly idleTimeoutMs: number
  readonly healthTimeoutMs: number
  readonly transactionMaxWaitMs: number
  readonly transactionTimeoutMs: number
}

export interface HttpRuntimeConfig {
  readonly host: string
  readonly port: number
  readonly drainTimeoutMs: number
  readonly shutdownGraceMs: number
}

export interface ApplicationRuntimeConfig {
  readonly environment: RuntimeEnvironment
  readonly http: HttpRuntimeConfig
  readonly database: DatabaseRuntimeConfig
}

export interface RuntimeConfigurationIssue {
  readonly path: string
  readonly rule: string
}

export class RuntimeConfigurationError extends Error {
  public constructor(readonly issues: readonly RuntimeConfigurationIssue[]) {
    super('Runtime configuration is invalid')
    this.name = 'RuntimeConfigurationError'
  }
}

export const APPLICATION_RUNTIME_CONFIG: unique symbol = Symbol(
  'APPLICATION_RUNTIME_CONFIG',
)
