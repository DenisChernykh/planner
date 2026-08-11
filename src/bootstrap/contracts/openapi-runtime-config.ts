import { buildApiRuntimeConfig } from '@/platform/config/runtime-environment'
import type { ApplicationRuntimeConfig } from '@/platform/config/runtime-config.types'

export function createOpenApiRuntimeConfig(): ApplicationRuntimeConfig {
  return buildApiRuntimeConfig({
    NODE_ENV: 'production',
    API_HOST: '127.0.0.1',
    API_PORT: 3000,
    DATABASE_URL:
      'postgresql://contract:contract@127.0.0.1:1/contract?schema=public',
    DATABASE_POOL_MAX: 1,
  })
}
