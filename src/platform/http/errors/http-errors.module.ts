import { Module, type DynamicModule } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'

import { HttpContextModule } from '@/platform/http/context/http-context.module'
import { LoggingModule } from '@/platform/logging/logging.module'

import type { HttpProblemContribution } from './problem.contracts'
import { HttpProblemRegistry } from './http-problem.registry'
import { ProblemExceptionFilter } from './problem-exception.filter'

@Module({})
export class HttpErrorsModule {
  public static forRoot(
    contributions: readonly HttpProblemContribution[],
  ): DynamicModule {
    return {
      module: HttpErrorsModule,
      imports: [HttpContextModule, LoggingModule],
      providers: [
        {
          provide: HttpProblemRegistry,
          useValue: new HttpProblemRegistry(contributions),
        },
        ProblemExceptionFilter,
        { provide: APP_FILTER, useExisting: ProblemExceptionFilter },
      ],
      exports: [HttpProblemRegistry],
    }
  }
}
