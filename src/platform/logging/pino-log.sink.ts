import pino, { type DestinationStream } from 'pino'

import type {
  LoggingRuntimeConfig,
  RuntimeEnvironment,
} from '@/platform/config/runtime-config.types'
import { isCanonicalRequestId } from '@/platform/http/context/request-id'

import type {
  CorrelationFields,
  LogLevel,
  StructuredLogger,
  StructuredLogRecord,
} from './logging.contracts'

import { serializeSafeError } from './safe-error.serializer'

const httpMethods = new Set([
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'TRACE',
])
const routeTemplate =
  /^(?:unmatched|\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*)){0,15})$/u
const diagnosticLevels = new Set<LogLevel>([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
])

export interface PinoLogSinkOptions {
  readonly destination?: DestinationStream
  readonly now?: () => Date
  readonly correlationFields?: () => CorrelationFields
}

export class PinoLogSink implements StructuredLogger {
  readonly #logger: pino.Logger
  readonly #correlation: () => CorrelationFields

  public constructor(
    config: {
      readonly environment: RuntimeEnvironment
      readonly logging: LoggingRuntimeConfig
    },
    options: PinoLogSinkOptions = {},
  ) {
    const now = options.now ?? (() => new Date())
    this.#correlation = options.correlationFields ?? (() => ({}))
    this.#logger = pino(
      {
        level: config.logging.level,
        base: { service: 'planner', environment: config.environment },
        timestamp: () => `,"timestamp":"${now().toISOString()}"`,
        formatters: { level: (level) => ({ level }) },
        serializers: { error: serializeSafeError },
      },
      options.destination,
    )
  }

  public write(record: StructuredLogRecord): void {
    if (!isValidRecord(record)) {
      throw new Error('Invalid structured log record')
    }
    const correlation = validateCorrelation({
      ...this.#correlation(),
      ...record.correlation,
    })
    this.#logger[record.level]({
      ...record.attributes,
      ...correlation,
      event: record.event,
      module: record.module,
      ...(record.error === undefined ? {} : { error: record.error }),
    })
  }
}

function validateCorrelation(
  fields: CorrelationFields,
): Readonly<Record<string, string>> {
  if (!hasOnlyKeys(fields, ['requestId'])) {
    throw new Error('Invalid structured log record')
  }
  if (fields.requestId === undefined) return {}
  if (!isCanonicalRequestId(fields.requestId)) {
    throw new Error('Invalid structured log record')
  }
  return { requestId: fields.requestId }
}

function isValidRecord(record: StructuredLogRecord): boolean {
  if (
    record === null ||
    typeof record !== 'object' ||
    !hasOnlyKeys(record, [
      'level',
      'event',
      'module',
      'attributes',
      'correlation',
      'error',
    ])
  ) {
    return false
  }
  switch (record.event) {
    case 'http_request_completed':
      return isValidAccessRecord(record)
    case 'http_unhandled_error':
      return (
        record.module === 'ProblemExceptionFilter' &&
        record.level === 'error' &&
        hasNoAttributes(record.attributes) &&
        record.error !== undefined
      )
    case 'otel_diagnostic':
      return (
        record.module === 'OpenTelemetry' &&
        diagnosticLevels.has(record.level) &&
        hasNoAttributes(record.attributes) &&
        record.error === undefined
      )
    default:
      return false
  }
}

function isValidAccessRecord(record: StructuredLogRecord): boolean {
  if (
    record.module !== 'HttpAccess' ||
    record.error !== undefined ||
    record.attributes === undefined ||
    !hasOnlyKeys(record.attributes, ['route', 'method', 'status', 'durationMs'])
  ) {
    return false
  }
  const { route, method, status, durationMs } = record.attributes
  return (
    typeof route === 'string' &&
    route.length <= 256 &&
    routeTemplate.test(route) &&
    typeof method === 'string' &&
    httpMethods.has(method) &&
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599 &&
    record.level === (status >= 500 ? 'error' : 'info') &&
    typeof durationMs === 'number' &&
    Number.isFinite(durationMs) &&
    durationMs >= 0 &&
    durationMs <= 60_000
  )
}

function hasNoAttributes(
  attributes: StructuredLogRecord['attributes'],
): boolean {
  return (
    attributes === undefined ||
    (attributes !== null &&
      typeof attributes === 'object' &&
      Object.keys(attributes).length === 0)
  )
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}
