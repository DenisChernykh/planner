import { Injectable } from '@nestjs/common'

import type { DatabaseReadinessProbe } from '@/platform/database/database.contracts'
import { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'
import type { ReadinessIndicator } from './readiness-indicator'

import type {
  HealthHttpResult,
  LivenessSnapshot,
  ReadinessSnapshot,
  StartupSnapshot,
} from './health.types'

@Injectable()
export class HealthService {
  public constructor(
    private readonly lifecycle: ApplicationLifecycleState,
    private readonly database: DatabaseReadinessProbe,
    private readonly redis: ReadinessIndicator,
  ) {}

  public live(): HealthHttpResult<LivenessSnapshot> {
    return { statusCode: 200, body: { status: 'ok' } }
  }

  public startup(): HealthHttpResult<StartupSnapshot> {
    return this.lifecycle.startupComplete
      ? { statusCode: 200, body: { status: 'ok' } }
      : { statusCode: 503, body: { status: 'starting' } }
  }

  public async ready(
    signal: AbortSignal,
  ): Promise<HealthHttpResult<ReadinessSnapshot>> {
    if (this.lifecycle.phase !== 'ready') {
      return { statusCode: 503, body: { status: 'unavailable' } }
    }
    const [database, redis] = await Promise.all([
      this.database.check(signal),
      this.redis.check(
        AbortSignal.any([
          signal,
          AbortSignal.timeout(this.redis.timeoutMs ?? 2_500),
        ]),
      ),
    ])
    if (
      this.lifecycle.phase !== 'ready' ||
      database !== 'up' ||
      redis !== 'up'
    ) {
      return { statusCode: 503, body: { status: 'unavailable' } }
    }
    return { statusCode: 200, body: { status: 'ok' } }
  }
}
