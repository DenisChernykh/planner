import { ValidationPipe } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'

import type { RequestContext } from '@/platform/http/context/request-context'
import { createRequestContextMiddleware } from '@/platform/http/context/request-context.middleware'
import { RequestValidationError } from '@/platform/http/errors/request-validation.error'
import { mapValidationErrors } from '@/platform/http/errors/validation-error.mapper'
import { createHttpAccessLogMiddleware } from '@/platform/logging/http-access-log.middleware'
import type { StructuredLogger } from '@/platform/logging/logging.contracts'
import type { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'

import type { ActiveRequestTracker } from './active-request-tracker'
import { createTrafficGateMiddleware } from './traffic-gate.middleware'

export interface HttpApplicationConfigurationOptions {
  readonly accessLogNow?: () => number
}

export function configureHttpApplication(
  app: NestExpressApplication,
  lifecycle: ApplicationLifecycleState,
  requestTracker: ActiveRequestTracker,
  requestContext: RequestContext,
  logger: StructuredLogger,
  options: HttpApplicationConfigurationOptions = {},
): void {
  app.use(createRequestContextMiddleware(requestContext))
  app.use(
    createHttpAccessLogMiddleware(requestContext, logger, options.accessLogNow),
  )
  app.use(createTrafficGateMiddleware(lifecycle))
  app.use(requestTracker.middleware())
  app.useBodyParser('json', { limit: 1_048_576 })
  app.useBodyParser('urlencoded', { extended: false, limit: 1_048_576 })
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      exceptionFactory: (errors) =>
        new RequestValidationError(mapValidationErrors(errors)),
    }),
  )
  const server = app.getHttpServer() as {
    requestTimeout: number
    headersTimeout: number
    keepAliveTimeout: number
  }
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
}
