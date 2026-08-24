import type {
  HttpProblemContribution,
  HttpProblemMapping,
} from '@/platform/http/errors/problem.contracts'

import {
  CurrentWorkspaceAuthorizationDeniedError,
  CurrentWorkspaceDependencyUnavailableError,
  CurrentWorkspaceStateConflictError,
} from '../application/workspace-errors'
import {
  WORKSPACE_AUTHORIZATION_DENIED_PROBLEM,
  WORKSPACE_STATE_CONFLICT_PROBLEM,
} from '../presentation/workspace-problem.definitions'

export const WORKSPACE_HTTP_PROBLEM_CONTRIBUTION: HttpProblemContribution =
  Object.freeze({
    definitions: Object.freeze([
      WORKSPACE_AUTHORIZATION_DENIED_PROBLEM,
      WORKSPACE_STATE_CONFLICT_PROBLEM,
    ]),
    mappedCodes: Object.freeze([
      'WORKSPACE_AUTHORIZATION_DENIED',
      'WORKSPACE_STATE_CONFLICT',
      'DEPENDENCY_UNAVAILABLE',
    ]),
    map: (error: unknown): HttpProblemMapping | undefined => {
      if (error instanceof CurrentWorkspaceAuthorizationDeniedError) {
        return { code: 'WORKSPACE_AUTHORIZATION_DENIED' }
      }
      if (error instanceof CurrentWorkspaceStateConflictError) {
        return { code: 'WORKSPACE_STATE_CONFLICT' }
      }
      if (error instanceof CurrentWorkspaceDependencyUnavailableError) {
        return { code: 'DEPENDENCY_UNAVAILABLE' }
      }
      return undefined
    },
  })
