import type {
  HttpProblemContribution,
  HttpProblemMapping,
} from '@/platform/http/errors/problem.contracts'
import { CommandValidationError } from '@/shared/application/application-command'

import {
  PilotReportAuthorizationDeniedError,
  PilotReportDependencyUnavailableError,
  PilotReportQueryValidationError,
  PilotReportSourceChangedError,
  PilotReportSourceInvalidError,
  PilotReportSourceNotFoundError,
} from '../application/pilot-report.errors'
import {
  REPORTING_AUTHORIZATION_DENIED_PROBLEM,
  REPORTING_NOT_FOUND_PROBLEM,
  REPORTING_QUERY_INVALID_PROBLEM,
  REPORTING_SOURCE_CHANGED_PROBLEM,
} from '../presentation/reporting-problem.definitions'

export const REPORTING_HTTP_PROBLEM_CONTRIBUTION: HttpProblemContribution =
  Object.freeze({
    definitions: Object.freeze([
      REPORTING_AUTHORIZATION_DENIED_PROBLEM,
      REPORTING_QUERY_INVALID_PROBLEM,
      REPORTING_NOT_FOUND_PROBLEM,
      REPORTING_SOURCE_CHANGED_PROBLEM,
    ]),
    mappedCodes: Object.freeze([
      'REPORTING_AUTHORIZATION_DENIED',
      'REPORTING_QUERY_INVALID',
      'REPORTING_NOT_FOUND',
      'REPORTING_SOURCE_CHANGED',
      'VALIDATION_FAILED',
      'DEPENDENCY_UNAVAILABLE',
    ]),
    map: (error: unknown): HttpProblemMapping | undefined => {
      if (error instanceof CommandValidationError) {
        return { code: 'VALIDATION_FAILED' }
      }
      if (error instanceof PilotReportAuthorizationDeniedError) {
        return { code: 'REPORTING_AUTHORIZATION_DENIED' }
      }
      if (error instanceof PilotReportQueryValidationError) {
        return { code: 'REPORTING_QUERY_INVALID' }
      }
      if (error instanceof PilotReportSourceNotFoundError) {
        return { code: 'REPORTING_NOT_FOUND' }
      }
      if (error instanceof PilotReportSourceChangedError) {
        return { code: 'REPORTING_SOURCE_CHANGED' }
      }
      if (
        error instanceof PilotReportSourceInvalidError ||
        error instanceof PilotReportDependencyUnavailableError
      ) {
        return { code: 'DEPENDENCY_UNAVAILABLE' }
      }
      return undefined
    },
  })
