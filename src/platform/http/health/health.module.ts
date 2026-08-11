import { Module } from '@nestjs/common'

import type { DatabaseReadinessProbe } from '@/platform/database/database.contracts'
import { DatabaseModule } from '@/platform/database/database.module'
import { DATABASE_READINESS_PROBE } from '@/platform/database/database.tokens'
import { ActiveRequestTracker } from '@/platform/http/bootstrap/active-request-tracker'
import { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'
import { LifecycleModule } from '@/platform/lifecycle/lifecycle.module'
import { RedisModule } from '@/platform/redis/redis.module'
import type { ReadinessIndicator } from '@/platform/http/health/readiness-indicator'
import { REDIS_READINESS_INDICATOR } from '@/platform/redis/redis.tokens'

import { HealthController } from './health.controller'
import { HealthService } from './health.service'

@Module({
  imports: [LifecycleModule, DatabaseModule, RedisModule],
  controllers: [HealthController],
  providers: [
    {
      provide: HealthService,
      inject: [
        ApplicationLifecycleState,
        DATABASE_READINESS_PROBE,
        REDIS_READINESS_INDICATOR,
      ],
      useFactory: (
        lifecycle: ApplicationLifecycleState,
        database: DatabaseReadinessProbe,
        redis: ReadinessIndicator,
      ) => new HealthService(lifecycle, database, redis),
    },
    ActiveRequestTracker,
  ],
  exports: [LifecycleModule, HealthService, ActiveRequestTracker],
})
export class HealthModule {}
