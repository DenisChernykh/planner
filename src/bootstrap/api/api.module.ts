import { Module, type DynamicModule } from '@nestjs/common'

import { AUTH_HTTP_PROBLEM_CONTRIBUTION } from '@/modules/auth/composition/auth-http-problem.contribution'
import { AuthModule } from '@/modules/auth/composition/auth.module'
import type { ApplicationRuntimeConfig } from '@/platform/config/runtime-config.types'
import { RuntimeConfigModule } from '@/platform/config/runtime-config.module'
import { DatabaseModule } from '@/platform/database/database.module'
import { HealthModule } from '@/platform/http/health/health.module'
import { HttpContextModule } from '@/platform/http/context/http-context.module'
import { HttpErrorsModule } from '@/platform/http/errors/http-errors.module'
import { CORE_HTTP_PROBLEM_CONTRIBUTION } from '@/platform/http/errors/http-problem.mapper'
import { LifecycleModule } from '@/platform/lifecycle/lifecycle.module'

@Module({})
export class ApiModule {
  public static forRoot(config: ApplicationRuntimeConfig): DynamicModule {
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
        ]),
        HealthModule,
        AuthModule,
      ],
    }
  }
}
