import Joi from 'joi'

import { runtimeDefaults } from './runtime-defaults'
import type { RuntimeLogLevel } from './runtime-config.types'

interface ValidatedRuntimeEnvironment {
  readonly NODE_ENV: 'development' | 'test' | 'production'
  readonly LOG_LEVEL: RuntimeLogLevel
  readonly API_HOST: string
  readonly API_PORT: number
  readonly DATABASE_URL: string
  readonly DATABASE_POOL_MAX: number
  readonly REDIS_AUTH_URL: string
  readonly REDIS_KEY_PREFIX: string
  readonly AUTH_SESSION_KEY_SECRET: Uint8Array
  readonly AUTH_CSRF_SECRET: Uint8Array
  readonly AUTH_OIDC_STATE_KEY_SECRET: Uint8Array
  readonly AUTH_CSRF_ORIGINS: readonly string[]
  readonly TELEGRAM_OIDC_CLIENT_ID: string
  readonly TELEGRAM_OIDC_CLIENT_SECRET: Uint8Array
  readonly TELEGRAM_OIDC_CALLBACK_URL: string
  readonly TELEGRAM_INGRESS_MODE: 'disabled' | 'get_updates'
  readonly TELEGRAM_BOT_TOKEN?: string
  readonly TELEGRAM_BOT_URL?: string
  readonly OTEL_SDK_DISABLED: boolean
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string
}

function isRedisUrl(value: string): boolean {
  try {
    return ['redis:', 'rediss:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function decodeSecret(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  return decoded.length === 32 && decoded.toString('base64url') === value
    ? new Uint8Array(decoded)
    : undefined
}

function encodeOidcClientSecret(value: string): Uint8Array | undefined {
  const encoded = Buffer.from(value, 'utf8')
  let containsControl = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      containsControl = true
      break
    }
  }
  return encoded.length >= 16 &&
    encoded.length <= 512 &&
    encoded.toString('utf8') === value &&
    !containsControl
    ? new Uint8Array(encoded)
    : undefined
}

function validTelegramBotToken(value: string): boolean {
  const size = Buffer.byteLength(value, 'utf8')
  return (
    size >= 20 &&
    size <= 256 &&
    Buffer.from(value, 'utf8').toString('utf8') === value &&
    !/\p{Cc}/u.test(value)
  )
}

function parseOrigins(value: string): readonly string[] | undefined {
  const origins = value.split(',').map((origin) => origin.trim())
  if (origins.length === 0 || origins.some((origin) => origin === ''))
    return undefined
  if (new Set(origins).size !== origins.length) return undefined
  for (const origin of origins) {
    try {
      const url = new URL(origin)
      if (
        url.origin !== origin ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username !== '' ||
        url.password !== '' ||
        url.pathname !== '/' ||
        url.search !== '' ||
        url.hash !== ''
      )
        return undefined
    } catch {
      return undefined
    }
  }
  return Object.freeze(origins)
}

function isPostgreSqlUrl(value: string): boolean {
  try {
    return ['postgres:', 'postgresql:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function isOidcCallbackUrl(
  value: string,
  environment: ValidatedRuntimeEnvironment['NODE_ENV'],
): boolean {
  try {
    const url = new URL(value)
    if (
      url.toString() !== value ||
      url.pathname !== '/auth/telegram/callback' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return false
    }
    if (url.protocol === 'https:') return true
    return (
      environment !== 'production' &&
      url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname)
    )
  } catch {
    return false
  }
}

export const runtimeEnvironmentSchema = Joi.object<ValidatedRuntimeEnvironment>(
  {
    NODE_ENV: Joi.string()
      .valid('development', 'test', 'production')
      .default('development'),
    LOG_LEVEL: Joi.string()
      .valid('trace', 'debug', 'info', 'warn', 'error', 'fatal')
      .default(runtimeDefaults.logging.level),
    API_HOST: Joi.string().trim().min(1).default('127.0.0.1'),
    API_PORT: Joi.number().integer().min(1).max(65_535).default(3000),
    DATABASE_URL: Joi.string()
      .trim()
      .required()
      .custom((value: string, helpers) =>
        isPostgreSqlUrl(value) ? value : helpers.error('any.invalid'),
      ),
    DATABASE_POOL_MAX: Joi.number().integer().min(1).max(100).default(10),
    REDIS_AUTH_URL: Joi.string()
      .trim()
      .required()
      .custom((value: string, helpers) =>
        isRedisUrl(value) ? value : helpers.error('any.invalid'),
      ),
    REDIS_KEY_PREFIX: Joi.string()
      .pattern(/^[A-Za-z0-9._-]+$/u)
      .default('planner'),
    AUTH_SESSION_KEY_SECRET: Joi.string()
      .required()
      .custom(
        (value: string, helpers) =>
          decodeSecret(value) ?? helpers.error('any.invalid'),
      ),
    AUTH_CSRF_SECRET: Joi.string()
      .required()
      .custom(
        (value: string, helpers) =>
          decodeSecret(value) ?? helpers.error('any.invalid'),
      ),
    AUTH_OIDC_STATE_KEY_SECRET: Joi.string()
      .required()
      .custom(
        (value: string, helpers) =>
          decodeSecret(value) ?? helpers.error('any.invalid'),
      ),
    AUTH_CSRF_ORIGINS: Joi.string()
      .required()
      .custom(
        (value: string, helpers) =>
          parseOrigins(value) ?? helpers.error('any.invalid'),
      ),
    TELEGRAM_OIDC_CLIENT_ID: Joi.string()
      .pattern(/^[1-9][0-9]*$/u)
      .required(),
    TELEGRAM_OIDC_CLIENT_SECRET: Joi.string()
      .required()
      .custom(
        (value: string, helpers) =>
          encodeOidcClientSecret(value) ?? helpers.error('any.invalid'),
      ),
    TELEGRAM_OIDC_CALLBACK_URL: Joi.string().required(),
    TELEGRAM_INGRESS_MODE: Joi.string()
      .valid('disabled', 'get_updates')
      .default('disabled'),
    TELEGRAM_BOT_TOKEN: Joi.string()
      .custom((value: string, helpers) =>
        validTelegramBotToken(value) ? value : helpers.error('any.invalid'),
      )
      .optional(),
    TELEGRAM_BOT_URL: Joi.string().allow('').max(2_048).optional(),
    OTEL_SDK_DISABLED: Joi.boolean().default(true),
    OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string()
      .trim()
      .uri({ scheme: ['http', 'https'] })
      .empty('')
      .optional(),
  },
).custom((value: ValidatedRuntimeEnvironment, helpers) => {
  const secrets = [
    value.AUTH_SESSION_KEY_SECRET,
    value.AUTH_CSRF_SECRET,
    value.AUTH_OIDC_STATE_KEY_SECRET,
  ].map((secret) => Buffer.from(secret).toString('base64url'))
  if (new Set(secrets).size !== secrets.length)
    return helpers.error('auth.secretsDistinct')
  if (
    value.NODE_ENV === 'production' &&
    value.AUTH_CSRF_ORIGINS.some(
      (origin) => new URL(origin).protocol !== 'https:',
    )
  )
    return helpers.error('auth.productionHttpsOrigin')
  if (!isOidcCallbackUrl(value.TELEGRAM_OIDC_CALLBACK_URL, value.NODE_ENV)) {
    return helpers.error('auth.oidcCallback')
  }
  if (
    value.TELEGRAM_INGRESS_MODE === 'get_updates' &&
    value.TELEGRAM_BOT_TOKEN === undefined
  ) {
    return helpers.error('telegram.botTokenRequired')
  }
  if (
    value.NODE_ENV === 'production' &&
    value.TELEGRAM_INGRESS_MODE !== 'disabled'
  ) {
    return helpers.error('telegram.productionIngressDeferred')
  }
  return value
}, 'auth runtime constraints')

export type { ValidatedRuntimeEnvironment }
