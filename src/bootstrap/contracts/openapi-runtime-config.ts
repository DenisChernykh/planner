import { buildApiRuntimeConfig } from '@/platform/config/runtime-environment'
import type { ApplicationRuntimeConfig } from '@/platform/config/runtime-config.types'

export function createOpenApiRuntimeConfig(): ApplicationRuntimeConfig {
  const sessionSecret = Buffer.alloc(32, 31).toString('base64url')
  const csrfSecret = Buffer.alloc(32, 32).toString('base64url')
  const oidcStateSecret = Buffer.alloc(32, 33).toString('base64url')
  return buildApiRuntimeConfig({
    NODE_ENV: 'production',
    API_HOST: '127.0.0.1',
    API_PORT: 3000,
    DATABASE_URL:
      'postgresql://contract:contract@127.0.0.1:1/contract?schema=public',
    DATABASE_POOL_MAX: 1,
    REDIS_AUTH_URL: 'redis://default:contract@127.0.0.1:1',
    REDIS_KEY_PREFIX: 'planner',
    AUTH_SESSION_KEY_SECRET: sessionSecret,
    AUTH_CSRF_SECRET: csrfSecret,
    AUTH_OIDC_STATE_KEY_SECRET: oidcStateSecret,
    AUTH_CSRF_ORIGINS: 'https://planner.invalid',
    TELEGRAM_OIDC_CLIENT_ID: '123456789',
    TELEGRAM_OIDC_CLIENT_SECRET: 'openapi-only-telegram-client-secret',
    TELEGRAM_OIDC_CALLBACK_URL:
      'https://planner.invalid/auth/telegram/callback',
  })
}
