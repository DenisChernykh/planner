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
  const production = environment.NODE_ENV === 'production'
  const sessionKeySecret = new Uint8Array(environment.AUTH_SESSION_KEY_SECRET)
  const csrfSecret = new Uint8Array(environment.AUTH_CSRF_SECRET)
  const oidcStateKeySecret = new Uint8Array(
    environment.AUTH_OIDC_STATE_KEY_SECRET,
  )
  const oidcClientSecret = new Uint8Array(
    environment.TELEGRAM_OIDC_CLIENT_SECRET,
  )
  const csrfOrigins = Object.freeze([...environment.AUTH_CSRF_ORIGINS])
  const auth = {
    sessionCookieName: production
      ? '__Host-planner-session'
      : 'planner-session',
    secureCookie: production,
    get sessionKeySecret(): Uint8Array {
      return new Uint8Array(sessionKeySecret)
    },
    get csrfSecret(): Uint8Array {
      return new Uint8Array(csrfSecret)
    },
    csrfOrigins,
    idleTimeoutMs: runtimeDefaults.auth.idleTimeoutMs,
    absoluteTimeoutMs: runtimeDefaults.auth.absoluteTimeoutMs,
    touchIntervalMs: runtimeDefaults.auth.touchIntervalMs,
    telegramOidc: Object.freeze({
      clientId: environment.TELEGRAM_OIDC_CLIENT_ID,
      get clientSecret(): Uint8Array {
        return new Uint8Array(oidcClientSecret)
      },
      callbackUrl: environment.TELEGRAM_OIDC_CALLBACK_URL,
      get stateKeySecret(): Uint8Array {
        return new Uint8Array(oidcStateKeySecret)
      },
      ...runtimeDefaults.auth.telegramOidc,
    }),
  }
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
    redis: Object.freeze({
      authUrl: environment.REDIS_AUTH_URL,
      keyPrefix: environment.REDIS_KEY_PREFIX,
      ...runtimeDefaults.redis,
    }),
    auth: Object.freeze(auth),
    telegramBot: Object.freeze({
      ingressMode: environment.TELEGRAM_INGRESS_MODE,
      ...(environment.TELEGRAM_BOT_TOKEN === undefined
        ? {}
        : { token: environment.TELEGRAM_BOT_TOKEN }),
      ...(environment.TELEGRAM_BOT_URL === undefined
        ? {}
        : { navigationUrl: environment.TELEGRAM_BOT_URL }),
      ...runtimeDefaults.telegramBot,
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
