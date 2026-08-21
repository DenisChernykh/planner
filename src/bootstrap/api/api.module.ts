import { Module, type DynamicModule } from '@nestjs/common'

import { AUTH_HTTP_PROBLEM_CONTRIBUTION } from '@/modules/auth/composition/auth-http-problem.contribution'
import { AuthModule } from '@/modules/auth/composition/auth.module'
import { PlanningModule } from '@/modules/planning/composition/planning.module'
import { PLANNING_HTTP_PROBLEM_CONTRIBUTION } from '@/modules/planning/composition/planning-http-problem.contribution'
import { RemindersModule } from '@/modules/reminders/composition/reminders.module'
import { REMINDERS_HTTP_PROBLEM_CONTRIBUTION } from '@/modules/reminders/composition/reminders-http-problem.contribution'
import { TrackingModule } from '@/modules/tracking/composition/tracking.module'
import { TRACKING_HTTP_PROBLEM_CONTRIBUTION } from '@/modules/tracking/composition/tracking-http-problem.contribution'
import { TelegramBotModule } from '@/modules/telegram-bot'
import type { ApplicationRuntimeConfig } from '@/platform/config/runtime-config.types'
import { RuntimeConfigModule } from '@/platform/config/runtime-config.module'
import { DatabaseModule } from '@/platform/database/database.module'
import { HealthModule } from '@/platform/http/health/health.module'
import { HttpContextModule } from '@/platform/http/context/http-context.module'
import { HttpErrorsModule } from '@/platform/http/errors/http-errors.module'
import { CORE_HTTP_PROBLEM_CONTRIBUTION } from '@/platform/http/errors/http-problem.mapper'
import { LifecycleModule } from '@/platform/lifecycle/lifecycle.module'
import type { ProductClock } from '@/shared/application/product-clock'

@Module({})
export class ApiModule {
  public static forRoot(
    config: ApplicationRuntimeConfig,
    trackingClock?: ProductClock,
  ): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        RuntimeConfigModule.forRoot(config),
        DatabaseModule,
        LifecycleModule,
        HttpContextModule,
        HttpErrorsModule.forRoot([
          CORE_HTTP_PROBLEM_CONTRIBUTION,
          AUTH_HTTP_PROBLEM_CONTRIBUTION,
          PLANNING_HTTP_PROBLEM_CONTRIBUTION,
          TRACKING_HTTP_PROBLEM_CONTRIBUTION,
          REMINDERS_HTTP_PROBLEM_CONTRIBUTION,
        ]),
        HealthModule,
        AuthModule,
        PlanningModule,
        TrackingModule.forRoot(trackingClock),
        RemindersModule.forRoot(trackingClock),
        TelegramBotModule.forRoot(trackingClock),
      ],
    }
  }
}
