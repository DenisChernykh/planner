export type RuntimeEnvironment = 'development' | 'test' | 'production'

export type RuntimeLogLevel =
  'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface LoggingRuntimeConfig {
  readonly level: RuntimeLogLevel
}

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

export interface OpenTelemetryRuntimeConfig {
  readonly disabled: boolean
  readonly endpoint?: string
  readonly exporterTimeoutMs: number
  readonly batchSpanScheduleDelayMs: number
  readonly batchSpanExportTimeoutMs: number
}

export interface ApplicationRuntimeConfig {
  readonly environment: RuntimeEnvironment
  readonly logging: LoggingRuntimeConfig
  readonly http: HttpRuntimeConfig
  readonly database: DatabaseRuntimeConfig
  readonly observability: OpenTelemetryRuntimeConfig
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
