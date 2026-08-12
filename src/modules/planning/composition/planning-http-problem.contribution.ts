import {
  CommandFingerprintConflictError,
  CommandValidationError,
} from '@/shared/application/application-command'
import type {
  HttpProblemContribution,
  HttpProblemMapping,
} from '@/platform/http/errors/problem.contracts'

import {
  DraftGoalNotFoundError,
  DraftRevisionConflictError,
  GoalDefinitionNotFoundError,
  GoalDefinitionRevisionConflictError,
  GoalDefinitionStateConflictError,
  GoalDefinitionVersionNotFoundError,
  PlanDraftNotEditableError,
  PlanDraftNotFoundError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from '../application/planning-errors'
import {
  COMMAND_FINGERPRINT_CONFLICT_PROBLEM,
  DRAFT_GOAL_NOT_FOUND_PROBLEM,
  DRAFT_REVISION_CONFLICT_PROBLEM,
  GOAL_DEFINITION_NOT_FOUND_PROBLEM,
  GOAL_DEFINITION_REVISION_CONFLICT_PROBLEM,
  GOAL_DEFINITION_STATE_CONFLICT_PROBLEM,
  GOAL_DEFINITION_VERSION_NOT_FOUND_PROBLEM,
  PLAN_DRAFT_NOT_EDITABLE_PROBLEM,
  PLAN_DRAFT_NOT_FOUND_PROBLEM,
  PLANNING_AUTHORIZATION_DENIED_PROBLEM,
} from '../presentation/planning-problem.definitions'

const bodyIssue = Object.freeze({
  pointer: '/body',
  code: 'invalid_value',
  detail: 'Request body is invalid.',
})

export const PLANNING_HTTP_PROBLEM_CONTRIBUTION: HttpProblemContribution =
  Object.freeze({
    definitions: Object.freeze([
      PLANNING_AUTHORIZATION_DENIED_PROBLEM,
      GOAL_DEFINITION_NOT_FOUND_PROBLEM,
      COMMAND_FINGERPRINT_CONFLICT_PROBLEM,
      GOAL_DEFINITION_REVISION_CONFLICT_PROBLEM,
      GOAL_DEFINITION_STATE_CONFLICT_PROBLEM,
      PLAN_DRAFT_NOT_FOUND_PROBLEM,
      DRAFT_GOAL_NOT_FOUND_PROBLEM,
      GOAL_DEFINITION_VERSION_NOT_FOUND_PROBLEM,
      PLAN_DRAFT_NOT_EDITABLE_PROBLEM,
      DRAFT_REVISION_CONFLICT_PROBLEM,
    ]),
    mappedCodes: Object.freeze([
      'PLANNING_AUTHORIZATION_DENIED',
      'GOAL_DEFINITION_NOT_FOUND',
      'COMMAND_FINGERPRINT_CONFLICT',
      'GOAL_DEFINITION_REVISION_CONFLICT',
      'GOAL_DEFINITION_STATE_CONFLICT',
      'PLAN_DRAFT_NOT_FOUND',
      'DRAFT_GOAL_NOT_FOUND',
      'GOAL_DEFINITION_VERSION_NOT_FOUND',
      'PLAN_DRAFT_NOT_EDITABLE',
      'DRAFT_REVISION_CONFLICT',
      'VALIDATION_FAILED',
      'DEPENDENCY_UNAVAILABLE',
    ]),
    map: (error: unknown): HttpProblemMapping | undefined => {
      if (error instanceof CommandValidationError) {
        return { code: 'VALIDATION_FAILED', errors: [bodyIssue] }
      }
      if (error instanceof CommandFingerprintConflictError) {
        return { code: 'COMMAND_FINGERPRINT_CONFLICT' }
      }
      if (error instanceof PlanningAuthorizationDeniedError) {
        return { code: 'PLANNING_AUTHORIZATION_DENIED' }
      }
      if (error instanceof GoalDefinitionNotFoundError) {
        return { code: 'GOAL_DEFINITION_NOT_FOUND' }
      }
      if (error instanceof GoalDefinitionRevisionConflictError) {
        return {
          code: 'GOAL_DEFINITION_REVISION_CONFLICT',
          conflict: {
            currentRevision: error.currentRevision.toString(10),
            currentState: error.currentState,
            nextAction: 'reload-goal-definition-and-retry',
          },
        }
      }
      if (error instanceof GoalDefinitionStateConflictError) {
        return {
          code: 'GOAL_DEFINITION_STATE_CONFLICT',
          conflict: {
            currentRevision: error.currentRevision.toString(10),
            currentState: error.currentState,
            nextAction: 'reload-goal-definition-and-retry',
          },
        }
      }
      if (error instanceof PlanDraftNotFoundError) {
        return { code: 'PLAN_DRAFT_NOT_FOUND' }
      }
      if (error instanceof DraftGoalNotFoundError) {
        return { code: 'DRAFT_GOAL_NOT_FOUND' }
      }
      if (error instanceof GoalDefinitionVersionNotFoundError) {
        return { code: 'GOAL_DEFINITION_VERSION_NOT_FOUND' }
      }
      if (error instanceof PlanDraftNotEditableError) {
        return { code: 'PLAN_DRAFT_NOT_EDITABLE' }
      }
      if (error instanceof DraftRevisionConflictError) {
        return {
          code: 'DRAFT_REVISION_CONFLICT',
          conflict: {
            expectedRevision: error.expectedRevision.toString(10),
            currentRevision: error.currentRevision.toString(10),
          },
        }
      }
      if (error instanceof PlanningDependencyUnavailableError) {
        return { code: 'DEPENDENCY_UNAVAILABLE' }
      }
      return undefined
    },
  })
