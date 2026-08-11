import { defineProblemDefinition } from '@/platform/http/errors/problem-registry'

export const PLANNING_AUTHORIZATION_DENIED_PROBLEM = defineProblemDefinition({
  slug: 'planning-authorization-denied',
  code: 'PLANNING_AUTHORIZATION_DENIED',
  status: 403,
  title: 'Planning authorization denied',
  detail: 'The current principal cannot access this planning operation.',
})

export const GOAL_DEFINITION_NOT_FOUND_PROBLEM = defineProblemDefinition({
  slug: 'goal-definition-not-found',
  code: 'GOAL_DEFINITION_NOT_FOUND',
  status: 404,
  title: 'Goal definition not found',
  detail: 'The requested goal definition was not found.',
})

export const COMMAND_FINGERPRINT_CONFLICT_PROBLEM = defineProblemDefinition({
  slug: 'command-fingerprint-conflict',
  code: 'COMMAND_FINGERPRINT_CONFLICT',
  status: 409,
  title: 'Command fingerprint conflict',
  detail: 'The command key already completed with a different request.',
})

export const GOAL_DEFINITION_REVISION_CONFLICT_PROBLEM =
  defineProblemDefinition({
    slug: 'goal-definition-revision-conflict',
    code: 'GOAL_DEFINITION_REVISION_CONFLICT',
    status: 409,
    title: 'Goal definition revision conflict',
    detail: 'The goal definition changed before this request was applied.',
  })

export const GOAL_DEFINITION_STATE_CONFLICT_PROBLEM = defineProblemDefinition({
  slug: 'goal-definition-state-conflict',
  code: 'GOAL_DEFINITION_STATE_CONFLICT',
  status: 409,
  title: 'Goal definition state conflict',
  detail: 'The goal definition is not in the required state.',
})
