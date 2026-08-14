import Joi, { type ValidationErrorItem } from 'joi'

import { runtimeDefaults } from './runtime-defaults'
import type {
  DatabaseRuntimeConfig,
  OpenTelemetryRuntimeConfig,
  RuntimeConfigurationIssue,
} from './runtime-config.types'
import { RuntimeConfigurationError } from './runtime-config.types'

export type PlannerWorkerRuntimeConfig = {
  readonly database: DatabaseRuntimeConfig
  readonly observability: OpenTelemetryRuntimeConfig
  readonly intervalMs: number
  readonly runnerShutdownGraceMs: 5_000
  readonly shutdownGraceMs: 10_000
}

type Environment = {
  readonly DATABASE_URL: string
  readonly DATABASE_POOL_MAX: number
  readonly PLANNER_WORKER_INTERVAL_MS: number
  readonly OTEL_SDK_DISABLED: boolean
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string
}

function postgresUrl(value: string): boolean {
  try {
    return ['postgres:', 'postgresql:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

const schema = Joi.object<Environment>({
  DATABASE_URL: Joi.string()
    .trim()
    .required()
    .custom((value: string, helpers) =>
      postgresUrl(value) ? value : helpers.error('any.invalid'),
    ),
  DATABASE_POOL_MAX: Joi.number().integer().min(1).max(100).default(10),
  PLANNER_WORKER_INTERVAL_MS: Joi.number()
    .integer()
    .min(15_000)
    .max(60_000)
    .default(30_000),
  OTEL_SDK_DISABLED: Joi.boolean().default(true),
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string()
    .trim()
    .uri({ scheme: ['http', 'https'] })
    .empty('')
    .optional(),
})

function issue(detail: ValidationErrorItem): RuntimeConfigurationIssue {
  return {
    path: detail.path.length === 0 ? 'runtime' : detail.path.join('.'),
    rule: detail.type,
  }
}

export function buildPlannerWorkerRuntimeConfig(
  input: Record<string, unknown>,
): PlannerWorkerRuntimeConfig {
  const result = schema.validate(input, {
    abortEarly: false,
    allowUnknown: true,
    convert: true,
  })
  if (result.error !== undefined) {
    throw new RuntimeConfigurationError(result.error.details.map(issue))
  }
  const environment = result.value
  const endpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT
  return Object.freeze({
    database: Object.freeze({
      url: environment.DATABASE_URL,
      poolMax: environment.DATABASE_POOL_MAX,
      ...runtimeDefaults.database,
    }),
    observability: Object.freeze({
      disabled: environment.OTEL_SDK_DISABLED,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...runtimeDefaults.observability,
    }),
    intervalMs: environment.PLANNER_WORKER_INTERVAL_MS,
    runnerShutdownGraceMs: 5_000,
    shutdownGraceMs: 10_000,
  })
}

export function createPlannerWorkerRuntimeConfig(): PlannerWorkerRuntimeConfig {
  return buildPlannerWorkerRuntimeConfig(process.env)
}
