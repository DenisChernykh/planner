import type { ValidationErrorItem } from 'joi'

import { runtimeDefaults } from './runtime-defaults'
import { runtimeEnvironmentSchema } from './runtime-environment.schema'
import {
  RuntimeConfigurationError,
  type ApplicationRuntimeConfig,
  type RuntimeConfigurationIssue,
} from './runtime-config.types'

function toIssue(detail: ValidationErrorItem): RuntimeConfigurationIssue {
  return {
    path: detail.path.length === 0 ? 'runtime' : detail.path.join('.'),
    rule: detail.type,
  }
}

export function buildApiRuntimeConfig(
  input: Record<string, unknown>,
): ApplicationRuntimeConfig {
  const result = runtimeEnvironmentSchema.validate(input, {
    abortEarly: false,
    allowUnknown: true,
    convert: true,
  })
  if (result.error !== undefined) {
    throw new RuntimeConfigurationError(result.error.details.map(toIssue))
  }
  const environment = result.value
  const endpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT
  return Object.freeze({
    environment: environment.NODE_ENV,
    logging: Object.freeze({
      level: environment.LOG_LEVEL,
    }),
    http: Object.freeze({
      host: environment.API_HOST,
      port: environment.API_PORT,
      ...runtimeDefaults.http,
    }),
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
  })
}

export function createApiRuntimeConfig(): ApplicationRuntimeConfig {
  return buildApiRuntimeConfig(process.env)
}
