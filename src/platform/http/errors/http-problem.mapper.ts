import { HttpException } from '@nestjs/common'

import type {
  HttpProblemContribution,
  HttpProblemMapping,
} from './problem.contracts'
import { PROBLEM_CATALOG, type CoreProblemCode } from './problem-registry'
import { RequestValidationError } from './request-validation.error'

const httpCodes: Readonly<Record<number, CoreProblemCode>> = Object.freeze({
  400: 'MALFORMED_REQUEST',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMIT_EXCEEDED',
  503: 'DEPENDENCY_UNAVAILABLE',
})

export const CORE_HTTP_PROBLEM_CONTRIBUTION: HttpProblemContribution =
  Object.freeze({
    definitions: PROBLEM_CATALOG,
    mappedCodes: PROBLEM_CATALOG.map(({ code }) => code),
    map: (error: unknown): HttpProblemMapping | undefined => {
      if (error instanceof RequestValidationError) {
        return { code: 'VALIDATION_FAILED', errors: error.errors }
      }
      if (isBodyParserError(error, 'entity.too.large', 413)) {
        return { code: 'PAYLOAD_TOO_LARGE' }
      }
      if (isBodyParserError(error, 'entity.parse.failed', 400)) {
        return { code: 'MALFORMED_REQUEST' }
      }
      if (error instanceof HttpException) {
        const code = httpCodes[error.getStatus()]
        return code === undefined ? undefined : { code }
      }
      return undefined
    },
  })

function isBodyParserError(
  error: unknown,
  type: string,
  status: number,
): boolean {
  return (
    error instanceof Error &&
    'type' in error &&
    error.type === type &&
    'status' in error &&
    error.status === status
  )
}
