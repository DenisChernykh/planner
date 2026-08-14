import type {
  HttpProblemContribution,
  HttpProblemMapping,
} from '@/platform/http/errors/problem.contracts'

import {
  CloseDayAlreadyClosedError,
  CloseDayPreviewConflictError,
  CloseDayRevisionConflictError,
  CloseDayTargetNotFoundError,
  CloseDayTargetUnavailableError,
  FactCorrectionRequiredError,
  FactRevisionConflictError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  FactUndoUnavailableError,
  FactValueInvalidError,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
  TrackingQueryValidationError,
  WeeklyTaskAlreadySystemClosedError,
  WeeklyTaskTargetNotFoundError,
  WeeklyTaskTargetUnavailableError,
} from '../application/tracking-errors'
import { CommandValidationError } from '@/shared/application/application-command'
import {
  TRACKING_AUTHORIZATION_DENIED_PROBLEM,
  TRACKING_CLOSE_DAY_ALREADY_CLOSED_PROBLEM,
  TRACKING_CLOSE_DAY_PREVIEW_CONFLICT_PROBLEM,
  TRACKING_CLOSE_DAY_REVISION_CONFLICT_PROBLEM,
  TRACKING_CLOSE_DAY_TARGET_NOT_FOUND_PROBLEM,
  TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE_PROBLEM,
  TRACKING_FACT_CORRECTION_REQUIRED_PROBLEM,
  TRACKING_FACT_REVISION_CONFLICT_PROBLEM,
  TRACKING_FACT_TARGET_NOT_FOUND_PROBLEM,
  TRACKING_FACT_TARGET_UNAVAILABLE_PROBLEM,
  TRACKING_FACT_UNDO_UNAVAILABLE_PROBLEM,
  TRACKING_FACT_VALUE_INVALID_PROBLEM,
  TRACKING_QUERY_INVALID_PROBLEM,
  TRACKING_WEEKLY_TASK_ALREADY_SYSTEM_CLOSED_PROBLEM,
  TRACKING_WEEKLY_TASK_TARGET_NOT_FOUND_PROBLEM,
  TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE_PROBLEM,
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
      TRACKING_FACT_UNDO_UNAVAILABLE_PROBLEM,
      TRACKING_FACT_CORRECTION_REQUIRED_PROBLEM,
      TRACKING_CLOSE_DAY_TARGET_NOT_FOUND_PROBLEM,
      TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE_PROBLEM,
      TRACKING_CLOSE_DAY_REVISION_CONFLICT_PROBLEM,
      TRACKING_CLOSE_DAY_PREVIEW_CONFLICT_PROBLEM,
      TRACKING_CLOSE_DAY_ALREADY_CLOSED_PROBLEM,
      TRACKING_WEEKLY_TASK_TARGET_NOT_FOUND_PROBLEM,
      TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE_PROBLEM,
      TRACKING_WEEKLY_TASK_ALREADY_SYSTEM_CLOSED_PROBLEM,
    ]),
    mappedCodes: Object.freeze([
      'TRACKING_AUTHORIZATION_DENIED',
      'TRACKING_QUERY_INVALID',
      'TRACKING_FACT_TARGET_NOT_FOUND',
      'TRACKING_FACT_TARGET_UNAVAILABLE',
      'TRACKING_FACT_REVISION_CONFLICT',
      'TRACKING_FACT_VALUE_INVALID',
      'TRACKING_FACT_UNDO_UNAVAILABLE',
      'TRACKING_FACT_CORRECTION_REQUIRED',
      'TRACKING_CLOSE_DAY_TARGET_NOT_FOUND',
      'TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE',
      'TRACKING_CLOSE_DAY_REVISION_CONFLICT',
      'TRACKING_CLOSE_DAY_PREVIEW_CONFLICT',
      'TRACKING_CLOSE_DAY_ALREADY_CLOSED',
      'TRACKING_WEEKLY_TASK_TARGET_NOT_FOUND',
      'TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE',
      'TRACKING_WEEKLY_TASK_ALREADY_SYSTEM_CLOSED',
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
      if (error instanceof FactUndoUnavailableError) {
        return {
          code: 'TRACKING_FACT_UNDO_UNAVAILABLE',
          conflict: {
            reason: error.reason,
            nextAction: 'reload-tracking-state',
          },
        }
      }
      if (error instanceof FactCorrectionRequiredError) {
        return {
          code: 'TRACKING_FACT_CORRECTION_REQUIRED',
          conflict: {
            factRecordId: error.existingRef.factRecordId,
            revision: error.existingRef.revision.toString(10),
            nextAction: 'correct-existing-record',
          },
        }
      }
      if (error instanceof CloseDayTargetNotFoundError) {
        return { code: 'TRACKING_CLOSE_DAY_TARGET_NOT_FOUND' }
      }
      if (error instanceof CloseDayTargetUnavailableError) {
        return {
          code: 'TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE',
          conflict: { reason: error.reason },
        }
      }
      if (error instanceof CloseDayRevisionConflictError) {
        return {
          code: 'TRACKING_CLOSE_DAY_REVISION_CONFLICT',
          conflict: {
            expectedRevision: error.expectedRevision.toString(10),
            currentRevision: error.currentRevision.toString(10),
            nextAction: 'reload-close-day-preview-and-retry',
          },
        }
      }
      if (error instanceof CloseDayPreviewConflictError) {
        return {
          code: 'TRACKING_CLOSE_DAY_PREVIEW_CONFLICT',
          conflict: { nextAction: 'reload-close-day-preview-and-retry' },
        }
      }
      if (error instanceof CloseDayAlreadyClosedError) {
        return {
          code: 'TRACKING_CLOSE_DAY_ALREADY_CLOSED',
          conflict: {
            dayCloseId: error.existingRef.dayCloseId,
            revision: error.existingRef.revision.toString(10),
            nextAction: 'open-closed-day',
          },
        }
      }
      if (error instanceof WeeklyTaskTargetNotFoundError) {
        return { code: 'TRACKING_WEEKLY_TASK_TARGET_NOT_FOUND' }
      }
      if (error instanceof WeeklyTaskTargetUnavailableError) {
        return {
          code: 'TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE',
          conflict: { reason: error.reason },
        }
      }
      if (error instanceof WeeklyTaskAlreadySystemClosedError) {
        return {
          code: 'TRACKING_WEEKLY_TASK_ALREADY_SYSTEM_CLOSED',
          conflict: {
            factRecordId: error.existingRef.factRecordId,
            revision: error.existingRef.revision.toString(10),
            nextAction: 'correct-existing-record',
          },
        }
      }
      if (error instanceof TrackingDependencyUnavailableError) {
        return { code: 'DEPENDENCY_UNAVAILABLE' }
      }
      return undefined
    },
  })
