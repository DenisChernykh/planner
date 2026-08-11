export interface CorrelationFields {
  readonly requestId?: string
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type StructuredLogAttribute = string | number | boolean

export interface StructuredLogRecord {
  readonly level: LogLevel
  readonly event: string
  readonly module: string
  readonly attributes?: Readonly<Record<string, StructuredLogAttribute>>
  readonly correlation?: CorrelationFields
  readonly error?: unknown
}

export interface StructuredLogger {
  write(record: StructuredLogRecord): void
}

export const STRUCTURED_LOGGER = Symbol('STRUCTURED_LOGGER')
