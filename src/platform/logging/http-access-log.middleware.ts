import { performance } from 'node:perf_hooks'

import type { RequestHandler } from 'express'

import type { RequestContext } from '@/platform/http/context/request-context'

import type { StructuredLogger } from './logging.contracts'
import { resolveHttpRouteTemplate } from './http-route-template'

export function createHttpAccessLogMiddleware(
  context: RequestContext,
  logger: StructuredLogger,
  now: () => number = () => performance.now(),
): RequestHandler {
  return (request, response, next) => {
    const started = now()
    let complete = false
    const finalize = (): void => {
      if (complete) return
      complete = true
      response.off('finish', finalize)
      response.off('close', finalize)
      try {
        const requestId = context.getRequestId()
        logger.write({
          level: response.statusCode >= 500 ? 'error' : 'info',
          event: 'http_request_completed',
          module: 'HttpAccess',
          correlation: requestId === undefined ? {} : { requestId },
          attributes: {
            route: resolveHttpRouteTemplate(request),
            method: /^[A-Z]{1,16}$/u.test(request.method.toUpperCase())
              ? request.method.toUpperCase()
              : 'OTHER',
            status: response.statusCode,
            durationMs: Math.max(0, now() - started),
          },
        })
      } catch {
        // Logging never changes the completed HTTP response.
      }
    }
    response.once('finish', finalize)
    response.once('close', finalize)
    next()
  }
}
