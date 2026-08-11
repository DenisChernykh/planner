import { Global, Module, type DynamicModule } from '@nestjs/common'

import { RuntimeConfigService } from './runtime-config.service'
import {
  APPLICATION_RUNTIME_CONFIG,
  type ApplicationRuntimeConfig,
} from './runtime-config.types'

@Global()
@Module({})
export class RuntimeConfigModule {
  public static forRoot(config: ApplicationRuntimeConfig): DynamicModule {
    return {
      module: RuntimeConfigModule,
      providers: [
        { provide: APPLICATION_RUNTIME_CONFIG, useValue: config },
        RuntimeConfigService,
      ],
      exports: [APPLICATION_RUNTIME_CONFIG, RuntimeConfigService],
    }
  }
}
