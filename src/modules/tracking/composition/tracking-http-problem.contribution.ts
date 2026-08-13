import type {
  HttpProblemContribution,
  HttpProblemMapping,
} from '@/platform/http/errors/problem.contracts'

import {
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
  TrackingQueryValidationError,
} from '../application/tracking-errors'
import {
  TRACKING_AUTHORIZATION_DENIED_PROBLEM,
  TRACKING_QUERY_INVALID_PROBLEM,
} from '../presentation/tracking-problem.definitions'

export const TRACKING_HTTP_PROBLEM_CONTRIBUTION: HttpProblemContribution =
  Object.freeze({
    definitions: Object.freeze([
      TRACKING_AUTHORIZATION_DENIED_PROBLEM,
      TRACKING_QUERY_INVALID_PROBLEM,
    ]),
    mappedCodes: Object.freeze([
      'TRACKING_AUTHORIZATION_DENIED',
      'TRACKING_QUERY_INVALID',
      'DEPENDENCY_UNAVAILABLE',
    ]),
    map: (error: unknown): HttpProblemMapping | undefined => {
      if (error instanceof TrackingAuthorizationDeniedError) {
        return { code: 'TRACKING_AUTHORIZATION_DENIED' }
      }
      if (error instanceof TrackingQueryValidationError) {
        return { code: 'TRACKING_QUERY_INVALID' }
      }
      if (error instanceof TrackingDependencyUnavailableError) {
        return { code: 'DEPENDENCY_UNAVAILABLE' }
      }
      return undefined
    },
  })
