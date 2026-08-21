import type {
  HttpProblemContribution,
  HttpProblemMapping,
} from '@/platform/http/errors/problem.contracts'
import { CommandValidationError } from '@/shared/application/application-command'

import {
  ReminderAuthorizationDeniedError,
  ReminderDependencyUnavailableError,
  ReminderScheduleRevisionConflictError,
} from '../application/reminder-errors'
import {
  REMINDER_AUTHORIZATION_DENIED_PROBLEM,
  REMINDER_SCHEDULE_REVISION_CONFLICT_PROBLEM,
} from '../presentation/reminder-problem.definitions'

const bodyIssue = Object.freeze({
  pointer: '/body',
  code: 'invalid_value',
  detail: 'Request body is invalid.',
})

export const REMINDERS_HTTP_PROBLEM_CONTRIBUTION: HttpProblemContribution =
  Object.freeze({
    definitions: Object.freeze([
      REMINDER_AUTHORIZATION_DENIED_PROBLEM,
      REMINDER_SCHEDULE_REVISION_CONFLICT_PROBLEM,
    ]),
    mappedCodes: Object.freeze([
      'REMINDER_AUTHORIZATION_DENIED',
      'REMINDER_SCHEDULE_REVISION_CONFLICT',
      'COMMAND_FINGERPRINT_CONFLICT',
      'VALIDATION_FAILED',
      'DEPENDENCY_UNAVAILABLE',
    ]),
    map: (error: unknown): HttpProblemMapping | undefined => {
      if (error instanceof CommandValidationError) {
        return { code: 'VALIDATION_FAILED', errors: [bodyIssue] }
      }
      if (error instanceof ReminderAuthorizationDeniedError) {
        return { code: 'REMINDER_AUTHORIZATION_DENIED' }
      }
      if (error instanceof ReminderScheduleRevisionConflictError) {
        return {
          code: 'REMINDER_SCHEDULE_REVISION_CONFLICT',
          conflict: {
            expectedRevision: error.expectedRevision?.toString(10) ?? null,
            currentRevision: error.currentRevision?.toString(10) ?? null,
            nextAction: 'reload-reminder-settings-and-retry',
          },
        }
      }
      if (error instanceof ReminderDependencyUnavailableError) {
        return { code: 'DEPENDENCY_UNAVAILABLE' }
      }
      return undefined
    },
  })
