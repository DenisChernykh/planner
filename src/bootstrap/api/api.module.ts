import { Module, type DynamicModule } from '@nestjs/common'

import type { ApplicationRuntimeConfig } from '@/platform/config/runtime-config.types'
import { RuntimeConfigModule } from '@/platform/config/runtime-config.module'
import { DatabaseModule } from '@/platform/database/database.module'
import { HealthModule } from '@/platform/http/health/health.module'
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
        HealthModule,
      ],
    }
  }
}
