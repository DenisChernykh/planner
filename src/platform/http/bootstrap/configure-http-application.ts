import type { NestExpressApplication } from '@nestjs/platform-express'

import type { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'

import type { ActiveRequestTracker } from './active-request-tracker'
import { createTrafficGateMiddleware } from './traffic-gate.middleware'

export function configureHttpApplication(
  app: NestExpressApplication,
  lifecycle: ApplicationLifecycleState,
  requestTracker: ActiveRequestTracker,
): void {
  app.use(createTrafficGateMiddleware(lifecycle))
  app.use(requestTracker.middleware())
}
