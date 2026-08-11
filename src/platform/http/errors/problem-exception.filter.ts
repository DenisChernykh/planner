import { randomUUID } from 'node:crypto'

import {
  Catch,
  Inject,
  Injectable,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'

import { RequestContext } from '@/platform/http/context/request-context'
import { REQUEST_ID_HEADER } from '@/platform/http/context/request-id'
import {
  STRUCTURED_LOGGER,
  type StructuredLogger,
} from '@/platform/logging/logging.contracts'

import { HttpProblemRegistry } from './http-problem.registry'
import type { ProblemDocument } from './problem.contracts'

@Catch()
@Injectable()
export class ProblemExceptionFilter implements ExceptionFilter<unknown> {
  public constructor(
    @Inject(HttpAdapterHost)
    private readonly adapterHost: HttpAdapterHost,
    @Inject(RequestContext)
    private readonly requestContext: RequestContext,
    @Inject(STRUCTURED_LOGGER) private readonly logger: StructuredLogger,
    @Inject(HttpProblemRegistry)
    private readonly registry: HttpProblemRegistry,
  ) {}

  public catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost
    const response = host.switchToHttp().getResponse<unknown>()
    if (httpAdapter.isHeadersSent(response)) return
    const mapped = this.registry.map(exception)
    const requestId = this.requestContext.getRequestId() ?? randomUUID()
    const document: ProblemDocument = {
      type: mapped.definition.type,
      title: mapped.definition.title,
      status: mapped.definition.status,
      detail: mapped.definition.detail,
      instance: `urn:request:${requestId}`,
      code: mapped.definition.code,
      requestId,
      ...(mapped.errors === undefined ? {} : { errors: mapped.errors }),
      ...(mapped.conflict === undefined ? {} : { conflict: mapped.conflict }),
    }
    httpAdapter.setHeader(response, REQUEST_ID_HEADER, requestId)
    httpAdapter.setHeader(response, 'Content-Type', 'application/problem+json')
    if (mapped.unexpected) {
      try {
        this.logger.write({
          level: 'error',
          event: 'http_unhandled_error',
          module: 'ProblemExceptionFilter',
          error: exception,
        })
      } catch {
        // Telemetry failure never changes the public error contract.
      }
    }
    httpAdapter.reply(response, document, mapped.definition.status)
  }
}
