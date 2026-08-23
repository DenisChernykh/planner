import { applyDecorators } from '@nestjs/common'
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger'

import {
  getProblemDefinition,
  type CoreProblemCode,
} from '@/platform/http/errors/problem-registry'
import type { RegisteredProblemDefinition } from '@/platform/http/errors/problem.contracts'

import {
  GoalDefinitionConflictProblemResponseDto,
  DraftConflictProblemResponseDto,
  DraftProblemConflictResponseDto,
  PlanMonthRevisionConflictProblemResponseDto,
  PlanMonthReopenConflictProblemResponseDto,
  PlanMonthRecloseConflictProblemResponseDto,
  PlanMonthRecloseConflictResponseDto,
  ReminderScheduleRevisionConflictProblemResponseDto,
  ReminderScheduleRevisionConflictResponseDto,
  ProblemFieldErrorResponseDto,
  ProblemConflictResponseDto,
  ProblemResponseDto,
  ValidationProblemResponseDto,
  PublicationPreviewConflictProblemResponseDto,
  PublicationPreviewConflictResponseDto,
  PlanMonthAlreadyPublishedProblemResponseDto,
  AlreadyPublishedConflictResponseDto,
  PlanPublicationBlockedProblemResponseDto,
  PublicationBlockerResponseDto,
  TrackingFactRevisionConflictResponseDto,
  TrackingFactRevisionProblemResponseDto,
  TrackingFactTargetUnavailableConflictResponseDto,
  TrackingFactTargetUnavailableProblemResponseDto,
  TrackingFactUndoConflictResponseDto,
  TrackingFactUndoProblemResponseDto,
  TrackingExistingFactConflictResponseDto,
  TrackingExistingFactProblemResponseDto,
  TrackingCloseDayTargetConflictResponseDto,
  TrackingCloseDayTargetProblemResponseDto,
  TrackingCloseDayRetryConflictResponseDto,
  TrackingCloseDayRetryProblemResponseDto,
  TrackingExistingDayCloseConflictResponseDto,
  TrackingExistingDayCloseProblemResponseDto,
  TrackingWeeklyTaskTargetConflictResponseDto,
  TrackingWeeklyTaskTargetProblemResponseDto,
} from './problem-response.dto'

const problemContentType = 'application/problem+json'

export function ApiProblemResponses(
  ...problems: readonly (CoreProblemCode | RegisteredProblemDefinition)[]
): ClassDecorator & MethodDecorator {
  const definitionsByStatus = new Map<number, RegisteredProblemDefinition[]>()
  for (const problem of problems) {
    const definition =
      typeof problem === 'string' ? getProblemDefinition(problem) : problem
    const definitions = definitionsByStatus.get(definition.status) ?? []
    definitions.push(definition)
    definitionsByStatus.set(definition.status, definitions)
  }
  const responses = [...definitionsByStatus].map(([status, definitions]) => {
    const responseTypes = [
      ...new Set(
        definitions.map(({ code }) => {
          if (code === 'VALIDATION_FAILED') return ValidationProblemResponseDto
          if (
            code === 'GOAL_DEFINITION_REVISION_CONFLICT' ||
            code === 'GOAL_DEFINITION_STATE_CONFLICT'
          ) {
            return GoalDefinitionConflictProblemResponseDto
          }
          if (code === 'DRAFT_REVISION_CONFLICT') {
            return DraftConflictProblemResponseDto
          }
          if (code === 'PLAN_MONTH_REVISION_CONFLICT') {
            return PlanMonthRevisionConflictProblemResponseDto
          }
          if (code === 'PLAN_MONTH_REOPEN_CONFLICT') {
            return PlanMonthReopenConflictProblemResponseDto
          }
          if (code === 'PLAN_MONTH_RECLOSE_CONFLICT') {
            return PlanMonthRecloseConflictProblemResponseDto
          }
          if (code === 'REMINDER_SCHEDULE_REVISION_CONFLICT') {
            return ReminderScheduleRevisionConflictProblemResponseDto
          }
          if (code === 'PUBLICATION_PREVIEW_CONFLICT') {
            return PublicationPreviewConflictProblemResponseDto
          }
          if (code === 'PLAN_MONTH_ALREADY_PUBLISHED') {
            return PlanMonthAlreadyPublishedProblemResponseDto
          }
          if (code === 'PLAN_PUBLICATION_BLOCKED') {
            return PlanPublicationBlockedProblemResponseDto
          }
          if (code === 'TRACKING_FACT_TARGET_UNAVAILABLE') {
            return TrackingFactTargetUnavailableProblemResponseDto
          }
          if (code === 'TRACKING_FACT_REVISION_CONFLICT') {
            return TrackingFactRevisionProblemResponseDto
          }
          if (code === 'TRACKING_FACT_UNDO_UNAVAILABLE') {
            return TrackingFactUndoProblemResponseDto
          }
          if (
            code === 'TRACKING_FACT_CORRECTION_REQUIRED' ||
            code === 'TRACKING_WEEKLY_TASK_ALREADY_SYSTEM_CLOSED'
          ) {
            return TrackingExistingFactProblemResponseDto
          }
          if (code === 'TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE') {
            return TrackingCloseDayTargetProblemResponseDto
          }
          if (
            code === 'TRACKING_CLOSE_DAY_REVISION_CONFLICT' ||
            code === 'TRACKING_CLOSE_DAY_PREVIEW_CONFLICT'
          ) {
            return TrackingCloseDayRetryProblemResponseDto
          }
          if (code === 'TRACKING_CLOSE_DAY_ALREADY_CLOSED') {
            return TrackingExistingDayCloseProblemResponseDto
          }
          if (code === 'TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE') {
            return TrackingWeeklyTaskTargetProblemResponseDto
          }
          return ProblemResponseDto
        }),
      ),
    ]
    const schemas = responseTypes.map((responseType) => ({
      $ref: getSchemaPath(responseType),
    }))
    const examples = Object.fromEntries(
      definitions.map((definition) => [
        definition.code,
        {
          summary: definition.title,
          value: problemExample(definition),
        },
      ]),
    )
    return ApiResponse({
      status,
      description: definitions.map(({ title }) => title).join('; '),
      content: {
        [problemContentType]: {
          schema: schemas.length === 1 ? schemas[0]! : { oneOf: schemas },
          examples,
        },
      },
    })
  })
  return applyDecorators(
    ApiExtraModels(
      ProblemFieldErrorResponseDto,
      ProblemConflictResponseDto,
      ProblemResponseDto,
      GoalDefinitionConflictProblemResponseDto,
      DraftProblemConflictResponseDto,
      DraftConflictProblemResponseDto,
      PlanMonthRevisionConflictProblemResponseDto,
      PlanMonthReopenConflictProblemResponseDto,
      PlanMonthRecloseConflictResponseDto,
      PlanMonthRecloseConflictProblemResponseDto,
      ReminderScheduleRevisionConflictProblemResponseDto,
      ReminderScheduleRevisionConflictResponseDto,
      ValidationProblemResponseDto,
      PublicationPreviewConflictResponseDto,
      PublicationPreviewConflictProblemResponseDto,
      AlreadyPublishedConflictResponseDto,
      PlanMonthAlreadyPublishedProblemResponseDto,
      PublicationBlockerResponseDto,
      PlanPublicationBlockedProblemResponseDto,
      TrackingFactTargetUnavailableConflictResponseDto,
      TrackingFactTargetUnavailableProblemResponseDto,
      TrackingFactRevisionConflictResponseDto,
      TrackingFactRevisionProblemResponseDto,
      TrackingFactUndoConflictResponseDto,
      TrackingFactUndoProblemResponseDto,
      TrackingExistingFactConflictResponseDto,
      TrackingExistingFactProblemResponseDto,
      TrackingCloseDayTargetConflictResponseDto,
      TrackingCloseDayTargetProblemResponseDto,
      TrackingCloseDayRetryConflictResponseDto,
      TrackingCloseDayRetryProblemResponseDto,
      TrackingExistingDayCloseConflictResponseDto,
      TrackingExistingDayCloseProblemResponseDto,
      TrackingWeeklyTaskTargetConflictResponseDto,
      TrackingWeeklyTaskTargetProblemResponseDto,
    ),
    ...responses,
  )
}

function problemExample(definition: RegisteredProblemDefinition): object {
  return {
    type: definition.type,
    title: definition.title,
    status: definition.status,
    detail: definition.detail,
    instance: 'urn:request:01ARZ3NDEKTSV4RRFFQ69G5FAV',
    code: definition.code,
    requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ...(definition.code === 'VALIDATION_FAILED'
      ? {
          errors: [
            {
              pointer: '/profile/name~1with~0reserved',
              code: 'invalid_type',
              detail: 'Field has an invalid type.',
            },
          ],
        }
      : {}),
    ...(definition.code === 'GOAL_DEFINITION_REVISION_CONFLICT' ||
    definition.code === 'GOAL_DEFINITION_STATE_CONFLICT'
      ? {
          conflict: {
            currentRevision: '2',
            currentState: 'active',
            nextAction: 'reload-goal-definition-and-retry',
          },
        }
      : {}),
    ...(definition.code === 'DRAFT_REVISION_CONFLICT'
      ? {
          conflict: { expectedRevision: '1', currentRevision: '2' },
        }
      : {}),
    ...(definition.code === 'PLAN_MONTH_REVISION_CONFLICT'
      ? {
          conflict: {
            expectedRevision: '1',
            currentRevision: '2',
            nextAction: 'reload-month-and-retry',
          },
        }
      : {}),
    ...(definition.code === 'PLAN_MONTH_REOPEN_CONFLICT'
      ? {
          conflict: {
            reason: 'not_closed',
            currentRevision: '3',
            currentStatus: 'grace',
            nextAction: 'reload-month',
          },
        }
      : {}),
    ...(definition.code === 'PLAN_MONTH_RECLOSE_CONFLICT'
      ? {
          conflict: {
            currentRevision: '4',
            currentStatus: 'closed',
            currentLifecycleMode: 'ordinary',
            nextAction: 'reload-month',
          },
        }
      : {}),
    ...(definition.code === 'REMINDER_SCHEDULE_REVISION_CONFLICT'
      ? {
          conflict: {
            expectedRevision: '1',
            currentRevision: '2',
            nextAction: 'reload-reminder-settings-and-retry',
          },
        }
      : {}),
    ...(definition.code === 'PUBLICATION_PREVIEW_CONFLICT'
      ? {
          conflict: {
            currentDraftRevision: '2',
            currentPreviewSchemaVersion: 'planner.publication-preview.v1',
            currentPreviewHashVersion: 'planner.publication-preview-hash.v1',
            currentPreviewHash: 'ab'.repeat(32),
            nextAction: 'reload-publication-preview-and-retry',
          },
        }
      : {}),
    ...(definition.code === 'PLAN_MONTH_ALREADY_PUBLISHED'
      ? {
          conflict: {
            publicationId: '11111111-1111-4111-8111-111111111111',
            publicationRevision: '1',
            nextAction: 'open-published-plan',
          },
        }
      : {}),
    ...(definition.code === 'PLAN_PUBLICATION_BLOCKED'
      ? {
          blockers: [
            {
              planGoalId: null,
              pointer: '/targetMonth',
              code: 'incompatible',
              detail: 'Target month is not current or next.',
            },
          ],
        }
      : {}),
    ...(definition.code === 'TRACKING_FACT_TARGET_UNAVAILABLE'
      ? { conflict: { reason: 'not_active' } }
      : {}),
    ...(definition.code === 'TRACKING_FACT_REVISION_CONFLICT'
      ? {
          conflict: { expectedRevision: '1', currentRevision: '2' },
        }
      : {}),
    ...(definition.code === 'TRACKING_FACT_UNDO_UNAVAILABLE'
      ? {
          conflict: {
            reason: 'not_latest',
            nextAction: 'reload-tracking-state',
          },
        }
      : {}),
    ...(definition.code === 'TRACKING_FACT_CORRECTION_REQUIRED' ||
    definition.code === 'TRACKING_WEEKLY_TASK_ALREADY_SYSTEM_CLOSED'
      ? {
          conflict: {
            factRecordId: '11111111-1111-4111-8111-111111111111',
            revision: '1',
            nextAction: 'correct-existing-record',
          },
        }
      : {}),
    ...(definition.code === 'TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE'
      ? { conflict: { reason: 'not_active' } }
      : {}),
    ...(definition.code === 'TRACKING_CLOSE_DAY_REVISION_CONFLICT'
      ? {
          conflict: {
            expectedRevision: '1',
            currentRevision: '2',
            nextAction: 'reload-close-day-preview-and-retry',
          },
        }
      : {}),
    ...(definition.code === 'TRACKING_CLOSE_DAY_PREVIEW_CONFLICT'
      ? {
          conflict: {
            nextAction: 'reload-close-day-preview-and-retry',
          },
        }
      : {}),
    ...(definition.code === 'TRACKING_CLOSE_DAY_ALREADY_CLOSED'
      ? {
          conflict: {
            dayCloseId: '11111111-1111-4111-8111-111111111111',
            revision: '1',
            nextAction: 'open-closed-day',
          },
        }
      : {}),
    ...(definition.code === 'TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE'
      ? { conflict: { reason: 'stale_period' } }
      : {}),
  }
}
