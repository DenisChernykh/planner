import type { AddressInfo } from 'node:net'

import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'

import { RuntimeConfigService } from '@/platform/config/runtime-config.service'
import type { ApplicationRuntimeConfig } from '@/platform/config/runtime-config.types'
import { createApiRuntimeConfig } from '@/platform/config/runtime-environment'
import type { DatabaseLifecycle } from '@/platform/database/database.contracts'
import { DATABASE_LIFECYCLE } from '@/platform/database/database.tokens'
import { ActiveRequestTracker } from '@/platform/http/bootstrap/active-request-tracker'
import { configureHttpApplication } from '@/platform/http/bootstrap/configure-http-application'
import { RequestContext } from '@/platform/http/context/request-context'
import {
  STRUCTURED_LOGGER,
  type StructuredLogger,
} from '@/platform/logging/logging.contracts'
import { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'
import type { RedisLifecyclePort } from '@/platform/redis/redis-lifecycle'
import { REDIS_LIFECYCLE } from '@/platform/redis/redis.tokens'

import { ApiModule } from './api.module'

export interface ApiApplicationHandle {
  listen(): Promise<void>
  closeListener(): Promise<void>
  closeIdleConnections(): void
  closeAllConnections(): void
  close(): Promise<void>
  address(): AddressInfo | string | null
}

export interface ApiRuntimeResources {
  readonly application: ApiApplicationHandle
  readonly database: DatabaseLifecycle
  readonly redis: RedisLifecyclePort
  readonly lifecycle: ApplicationLifecycleState
  readonly requestTracker: ActiveRequestTracker
  readonly httpDrainTimeoutMs: number
  readonly shutdownGraceMs: number
}

export async function configureApi(
  runtimeConfig: ApplicationRuntimeConfig = createApiRuntimeConfig(),
): Promise<ApiRuntimeResources> {
  const app = await NestFactory.create<NestExpressApplication>(
    ApiModule.forRoot(runtimeConfig),
    { logger: false },
  )
  const config = app.get(RuntimeConfigService)
  const lifecycle = app.get(ApplicationLifecycleState)
  const database = app.get<DatabaseLifecycle>(DATABASE_LIFECYCLE)
  const redis = app.get<RedisLifecyclePort>(REDIS_LIFECYCLE)
  const requestTracker = app.get(ActiveRequestTracker)
  configureHttpApplication(
    app,
    lifecycle,
    requestTracker,
    app.get(RequestContext),
    app.get<StructuredLogger>(STRUCTURED_LOGGER),
  )
  await app.init()
  const server = app.getHttpServer()

  return {
    database,
    redis,
    lifecycle,
    requestTracker,
    httpDrainTimeoutMs: config.http.drainTimeoutMs,
    shutdownGraceMs: config.http.shutdownGraceMs,
    application: {
      listen: async () => {
        await app.listen(config.http.port, config.http.host)
      },
      closeListener: () => {
        try {
          server.close()
          return Promise.resolve()
        } catch (error: unknown) {
          return (error as NodeJS.ErrnoException).code ===
            'ERR_SERVER_NOT_RUNNING'
            ? Promise.resolve()
            : Promise.reject(
                error instanceof Error
                  ? error
                  : new Error('Listener close failed'),
              )
        }
      },
      closeIdleConnections: () => server.closeIdleConnections(),
      closeAllConnections: () => server.closeAllConnections(),
      close: () => app.close(),
      address: () => server.address(),
    },
  }
}
