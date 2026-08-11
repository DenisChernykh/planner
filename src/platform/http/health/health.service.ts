import { Injectable } from '@nestjs/common'

import type { DatabaseReadinessProbe } from '@/platform/database/database.contracts'
import { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'

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
    const status = await this.database.check(signal)
    if (this.lifecycle.phase !== 'ready' || status !== 'up') {
      return { statusCode: 503, body: { status: 'unavailable' } }
    }
    return { statusCode: 200, body: { status: 'ok' } }
  }
}
