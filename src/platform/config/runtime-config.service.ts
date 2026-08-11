import { Inject, Injectable } from '@nestjs/common'

import {
  APPLICATION_RUNTIME_CONFIG,
  type ApplicationRuntimeConfig,
  type DatabaseRuntimeConfig,
  type HttpRuntimeConfig,
  type RuntimeEnvironment,
} from './runtime-config.types'

@Injectable()
export class RuntimeConfigService {
  public constructor(
    @Inject(APPLICATION_RUNTIME_CONFIG)
    private readonly config: ApplicationRuntimeConfig,
  ) {}

  public get environment(): RuntimeEnvironment {
    return this.config.environment
  }

  public get http(): HttpRuntimeConfig {
    return this.config.http
  }

  public get database(): DatabaseRuntimeConfig {
    return this.config.database
  }
}
