import { CommandValidationError } from '@/shared/application/application-command'
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
  PlanMonthAlreadyExistsError,
  PlanSeedAlreadyConsumedError,
  ActivePlanMonthNotFoundError,
  PlanMonthAlreadyPublishedError,
  PlanPublicationBlockedError,
  PlanPublicationNotFoundError,
  PublicationPreviewConflictError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
  PlanMonthNotFoundError,
  PlanMonthRevisionConflictError,
  PlanMonthReopenConflictError,
} from '../application/planning-errors'
import {
  DRAFT_GOAL_NOT_FOUND_PROBLEM,
  DRAFT_REVISION_CONFLICT_PROBLEM,
  GOAL_DEFINITION_NOT_FOUND_PROBLEM,
  GOAL_DEFINITION_REVISION_CONFLICT_PROBLEM,
  GOAL_DEFINITION_STATE_CONFLICT_PROBLEM,
  GOAL_DEFINITION_VERSION_NOT_FOUND_PROBLEM,
  PLAN_DRAFT_NOT_EDITABLE_PROBLEM,
  PLAN_DRAFT_NOT_FOUND_PROBLEM,
  PLAN_MONTH_ALREADY_EXISTS_PROBLEM,
  PLAN_SEED_ALREADY_CONSUMED_PROBLEM,
  PLANNING_AUTHORIZATION_DENIED_PROBLEM,
  ACTIVE_PLAN_MONTH_NOT_FOUND_PROBLEM,
  PLAN_MONTH_ALREADY_PUBLISHED_PROBLEM,
  PLAN_PUBLICATION_BLOCKED_PROBLEM,
  PLAN_PUBLICATION_NOT_FOUND_PROBLEM,
  PUBLICATION_PREVIEW_CONFLICT_PROBLEM,
  PLAN_MONTH_NOT_FOUND_PROBLEM,
  PLAN_MONTH_REVISION_CONFLICT_PROBLEM,
  PLAN_MONTH_REOPEN_CONFLICT_PROBLEM,
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
      GOAL_DEFINITION_REVISION_CONFLICT_PROBLEM,
      GOAL_DEFINITION_STATE_CONFLICT_PROBLEM,
      PLAN_DRAFT_NOT_FOUND_PROBLEM,
      PLAN_MONTH_ALREADY_EXISTS_PROBLEM,
      PLAN_SEED_ALREADY_CONSUMED_PROBLEM,
      DRAFT_GOAL_NOT_FOUND_PROBLEM,
      GOAL_DEFINITION_VERSION_NOT_FOUND_PROBLEM,
      PLAN_DRAFT_NOT_EDITABLE_PROBLEM,
      DRAFT_REVISION_CONFLICT_PROBLEM,
      PUBLICATION_PREVIEW_CONFLICT_PROBLEM,
      PLAN_PUBLICATION_BLOCKED_PROBLEM,
      PLAN_MONTH_ALREADY_PUBLISHED_PROBLEM,
      PLAN_PUBLICATION_NOT_FOUND_PROBLEM,
      ACTIVE_PLAN_MONTH_NOT_FOUND_PROBLEM,
      PLAN_MONTH_NOT_FOUND_PROBLEM,
      PLAN_MONTH_REVISION_CONFLICT_PROBLEM,
      PLAN_MONTH_REOPEN_CONFLICT_PROBLEM,
    ]),
    mappedCodes: Object.freeze([
      'PLANNING_AUTHORIZATION_DENIED',
      'GOAL_DEFINITION_NOT_FOUND',
      'GOAL_DEFINITION_REVISION_CONFLICT',
      'GOAL_DEFINITION_STATE_CONFLICT',
      'PLAN_DRAFT_NOT_FOUND',
      'PLAN_MONTH_ALREADY_EXISTS',
      'PLAN_SEED_ALREADY_CONSUMED',
      'DRAFT_GOAL_NOT_FOUND',
      'GOAL_DEFINITION_VERSION_NOT_FOUND',
      'PLAN_DRAFT_NOT_EDITABLE',
      'DRAFT_REVISION_CONFLICT',
      'PUBLICATION_PREVIEW_CONFLICT',
      'PLAN_PUBLICATION_BLOCKED',
      'PLAN_MONTH_ALREADY_PUBLISHED',
      'PLAN_PUBLICATION_NOT_FOUND',
      'ACTIVE_PLAN_MONTH_NOT_FOUND',
      'PLAN_MONTH_NOT_FOUND',
      'PLAN_MONTH_REVISION_CONFLICT',
      'PLAN_MONTH_REOPEN_CONFLICT',
      'VALIDATION_FAILED',
      'DEPENDENCY_UNAVAILABLE',
    ]),
    map: (error: unknown): HttpProblemMapping | undefined => {
      if (error instanceof CommandValidationError) {
        return { code: 'VALIDATION_FAILED', errors: [bodyIssue] }
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
      if (error instanceof PlanMonthAlreadyExistsError) {
        return { code: 'PLAN_MONTH_ALREADY_EXISTS' }
      }
      if (error instanceof PlanSeedAlreadyConsumedError) {
        return { code: 'PLAN_SEED_ALREADY_CONSUMED' }
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
      if (error instanceof PublicationPreviewConflictError) {
        return {
          code: 'PUBLICATION_PREVIEW_CONFLICT',
          conflict: {
            currentDraftRevision: error.currentDraftRevision.toString(10),
            currentPreviewSchemaVersion: error.currentPreviewSchemaVersion,
            currentPreviewHashVersion: error.currentPreviewHashVersion,
            currentPreviewHash: error.currentPreviewHash,
            nextAction: 'reload-publication-preview-and-retry',
          },
        }
      }
      if (error instanceof PlanPublicationBlockedError) {
        return { code: 'PLAN_PUBLICATION_BLOCKED', blockers: error.blockers }
      }
      if (error instanceof PlanMonthAlreadyPublishedError) {
        return {
          code: 'PLAN_MONTH_ALREADY_PUBLISHED',
          conflict: {
            publicationId: error.publicationId,
            publicationRevision: error.publicationRevision.toString(10),
            nextAction: 'open-published-plan',
          },
        }
      }
      if (error instanceof PlanPublicationNotFoundError) {
        return { code: 'PLAN_PUBLICATION_NOT_FOUND' }
      }
      if (error instanceof ActivePlanMonthNotFoundError) {
        return { code: 'ACTIVE_PLAN_MONTH_NOT_FOUND' }
      }
      if (error instanceof PlanMonthNotFoundError) {
        return { code: 'PLAN_MONTH_NOT_FOUND' }
      }
      if (error instanceof PlanMonthRevisionConflictError) {
        return {
          code: 'PLAN_MONTH_REVISION_CONFLICT',
          conflict: {
            expectedRevision: error.expectedRevision.toString(10),
            currentRevision: error.currentRevision.toString(10),
            nextAction: 'reload-month-and-retry',
          },
        }
      }
      if (error instanceof PlanMonthReopenConflictError) {
        return {
          code: 'PLAN_MONTH_REOPEN_CONFLICT',
          conflict: {
            reason: error.reason,
            currentRevision: error.currentRevision.toString(10),
            currentStatus: error.currentStatus,
            nextAction: 'reload-month',
          },
        }
      }
      if (error instanceof PlanningDependencyUnavailableError) {
        return { code: 'DEPENDENCY_UNAVAILABLE' }
      }
      return undefined
    },
  })
