import type {
  HttpProblemContribution,
  HttpProblemMapping,
} from '@/platform/http/errors/problem.contracts'

import {
  FactRevisionConflictError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  FactValueInvalidError,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
  TrackingQueryValidationError,
} from '../application/tracking-errors'
import { CommandValidationError } from '@/shared/application/application-command'
import {
  TRACKING_AUTHORIZATION_DENIED_PROBLEM,
  TRACKING_FACT_REVISION_CONFLICT_PROBLEM,
  TRACKING_FACT_TARGET_NOT_FOUND_PROBLEM,
  TRACKING_FACT_TARGET_UNAVAILABLE_PROBLEM,
  TRACKING_FACT_VALUE_INVALID_PROBLEM,
  TRACKING_QUERY_INVALID_PROBLEM,
} from '../presentation/tracking-problem.definitions'

const bodyIssue = Object.freeze({
  pointer: '/body',
  code: 'invalid_value',
  detail: 'Request body is invalid.',
})

export const TRACKING_HTTP_PROBLEM_CONTRIBUTION: HttpProblemContribution =
  Object.freeze({
    definitions: Object.freeze([
      TRACKING_AUTHORIZATION_DENIED_PROBLEM,
      TRACKING_QUERY_INVALID_PROBLEM,
      TRACKING_FACT_TARGET_NOT_FOUND_PROBLEM,
      TRACKING_FACT_TARGET_UNAVAILABLE_PROBLEM,
      TRACKING_FACT_REVISION_CONFLICT_PROBLEM,
      TRACKING_FACT_VALUE_INVALID_PROBLEM,
    ]),
    mappedCodes: Object.freeze([
      'TRACKING_AUTHORIZATION_DENIED',
      'TRACKING_QUERY_INVALID',
      'TRACKING_FACT_TARGET_NOT_FOUND',
      'TRACKING_FACT_TARGET_UNAVAILABLE',
      'TRACKING_FACT_REVISION_CONFLICT',
      'TRACKING_FACT_VALUE_INVALID',
      'VALIDATION_FAILED',
      'DEPENDENCY_UNAVAILABLE',
    ]),
    map: (error: unknown): HttpProblemMapping | undefined => {
      if (error instanceof CommandValidationError) {
        return { code: 'VALIDATION_FAILED', errors: [bodyIssue] }
      }
      if (error instanceof TrackingAuthorizationDeniedError) {
        return { code: 'TRACKING_AUTHORIZATION_DENIED' }
      }
      if (error instanceof TrackingQueryValidationError) {
        return { code: 'TRACKING_QUERY_INVALID' }
      }
      if (error instanceof FactTargetNotFoundError) {
        return { code: 'TRACKING_FACT_TARGET_NOT_FOUND' }
      }
      if (error instanceof FactTargetUnavailableError) {
        return {
          code: 'TRACKING_FACT_TARGET_UNAVAILABLE',
          conflict: { reason: error.reason },
        }
      }
      if (error instanceof FactRevisionConflictError) {
        return {
          code: 'TRACKING_FACT_REVISION_CONFLICT',
          conflict: {
            expectedRevision: error.expectedRevision?.toString(10) ?? null,
            currentRevision: error.currentRevision?.toString(10) ?? null,
          },
        }
      }
      if (error instanceof FactValueInvalidError) {
        return { code: 'TRACKING_FACT_VALUE_INVALID' }
      }
      if (error instanceof TrackingDependencyUnavailableError) {
        return { code: 'DEPENDENCY_UNAVAILABLE' }
      }
      return undefined
    },
  })
