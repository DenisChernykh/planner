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

export interface RedisRuntimeConfig {
  readonly authUrl: string
  readonly keyPrefix: string
  readonly connectTimeoutMs: number
  readonly commandTimeoutMs: number
  readonly healthTimeoutMs: number
  readonly shutdownTimeoutMs: number
}

export interface AuthRuntimeConfig {
  readonly sessionCookieName: string
  readonly secureCookie: boolean
  readonly sessionKeySecret: Uint8Array
  readonly csrfSecret: Uint8Array
  readonly csrfOrigins: readonly string[]
  readonly idleTimeoutMs: number
  readonly absoluteTimeoutMs: number
  readonly touchIntervalMs: number
  readonly telegramOidc: TelegramOidcRuntimeConfig
}

export interface TelegramOidcRuntimeConfig {
  readonly clientId: string
  readonly callbackUrl: string
  readonly stateKeySecret: Uint8Array
  readonly discoveryTimeoutMs: number
  readonly discoveryBodyLimitBytes: number
  readonly transactionTtlMs: number
  readonly stateCookieMaxAgeMs: number
}

export interface ApplicationRuntimeConfig {
  readonly environment: RuntimeEnvironment
  readonly logging: LoggingRuntimeConfig
  readonly http: HttpRuntimeConfig
  readonly database: DatabaseRuntimeConfig
  readonly redis: RedisRuntimeConfig
  readonly auth: AuthRuntimeConfig
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
