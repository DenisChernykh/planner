import { Inject, Injectable } from '@nestjs/common'

import {
  APPLICATION_RUNTIME_CONFIG,
  type ApplicationRuntimeConfig,
  type DatabaseRuntimeConfig,
  type HttpRuntimeConfig,
  type LoggingRuntimeConfig,
  type OpenTelemetryRuntimeConfig,
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

  public get logging(): LoggingRuntimeConfig {
    return this.config.logging
  }

  public get database(): DatabaseRuntimeConfig {
    return this.config.database
  }

  public get observability(): OpenTelemetryRuntimeConfig {
    return this.config.observability
  }
}
