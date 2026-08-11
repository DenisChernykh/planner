import { trace } from '@opentelemetry/api'
import type { RequestHandler } from 'express'

import { REQUEST_ID_HEADER, resolveRequestId } from './request-id'
import type { RequestContext } from './request-context'

export function createRequestContextMiddleware(
  context: RequestContext,
): RequestHandler {
  return (request, response, next) => {
    const { requestId } = resolveRequestId(request.headers['x-request-id'])
    trace.getActiveSpan()?.setAttribute('planner.request_id', requestId)
    context.run(requestId, () => {
      response.setHeader(REQUEST_ID_HEADER, requestId)
      next()
    })
  }
}
