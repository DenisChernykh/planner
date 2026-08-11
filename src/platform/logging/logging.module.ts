import { Module } from '@nestjs/common'

import { RuntimeConfigService } from '@/platform/config/runtime-config.service'
import { RequestContext } from '@/platform/http/context/request-context'

import { STRUCTURED_LOGGER } from './logging.contracts'
import { PinoLogSink } from './pino-log.sink'

@Module({
  providers: [
    {
      provide: STRUCTURED_LOGGER,
      inject: [RequestContext, RuntimeConfigService],
      useFactory: (context: RequestContext, config: RuntimeConfigService) =>
        new PinoLogSink(config, {
          correlationFields: () => {
            const requestId = context.getRequestId()
            return requestId === undefined ? {} : { requestId }
          },
        }),
    },
  ],
  exports: [STRUCTURED_LOGGER],
})
export class LoggingModule {}
