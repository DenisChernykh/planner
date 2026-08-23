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

export const PLAN_DRAFT_NOT_FOUND_PROBLEM = defineProblemDefinition({
  slug: 'plan-draft-not-found',
  code: 'PLAN_DRAFT_NOT_FOUND',
  status: 404,
  title: 'Plan draft not found',
  detail: 'The requested plan draft was not found.',
})

export const PLAN_MONTH_ALREADY_EXISTS_PROBLEM = defineProblemDefinition({
  slug: 'plan-month-already-exists',
  code: 'PLAN_MONTH_ALREADY_EXISTS',
  status: 409,
  title: 'Plan month already exists',
  detail: 'A plan already exists for the requested calendar month.',
})

export const PLAN_SEED_ALREADY_CONSUMED_PROBLEM = defineProblemDefinition({
  slug: 'plan-seed-already-consumed',
  code: 'PLAN_SEED_ALREADY_CONSUMED',
  status: 409,
  title: 'Plan seed already consumed',
  detail: 'The one-time April plan seed has already been consumed.',
})

export const DRAFT_GOAL_NOT_FOUND_PROBLEM = defineProblemDefinition({
  slug: 'draft-goal-not-found',
  code: 'DRAFT_GOAL_NOT_FOUND',
  status: 404,
  title: 'Draft goal not found',
  detail: 'The requested draft goal was not found.',
})

export const GOAL_DEFINITION_VERSION_NOT_FOUND_PROBLEM =
  defineProblemDefinition({
    slug: 'goal-definition-version-not-found',
    code: 'GOAL_DEFINITION_VERSION_NOT_FOUND',
    status: 404,
    title: 'Goal definition version not found',
    detail: 'The requested goal definition version was not found.',
  })

export const PLAN_DRAFT_NOT_EDITABLE_PROBLEM = defineProblemDefinition({
  slug: 'plan-draft-not-editable',
  code: 'PLAN_DRAFT_NOT_EDITABLE',
  status: 409,
  title: 'Plan draft not editable',
  detail: 'The plan month is not an editable draft.',
})

export const DRAFT_REVISION_CONFLICT_PROBLEM = defineProblemDefinition({
  slug: 'draft-revision-conflict',
  code: 'DRAFT_REVISION_CONFLICT',
  status: 409,
  title: 'Plan draft revision conflict',
  detail: 'The plan draft changed before this request completed.',
})

export const PUBLICATION_PREVIEW_CONFLICT_PROBLEM = defineProblemDefinition({
  slug: 'publication-preview-conflict',
  code: 'PUBLICATION_PREVIEW_CONFLICT',
  status: 409,
  title: 'Publication preview conflict',
  detail: 'The confirmed publication preview is no longer current.',
})

export const PLAN_PUBLICATION_BLOCKED_PROBLEM = defineProblemDefinition({
  slug: 'plan-publication-blocked',
  code: 'PLAN_PUBLICATION_BLOCKED',
  status: 409,
  title: 'Plan publication blocked',
  detail: 'The current plan draft contains publication blockers.',
})

export const PLAN_MONTH_ALREADY_PUBLISHED_PROBLEM = defineProblemDefinition({
  slug: 'plan-month-already-published',
  code: 'PLAN_MONTH_ALREADY_PUBLISHED',
  status: 409,
  title: 'Plan month already published',
  detail: 'The plan month already has an active immutable publication.',
})

export const PLAN_PUBLICATION_NOT_FOUND_PROBLEM = defineProblemDefinition({
  slug: 'plan-publication-not-found',
  code: 'PLAN_PUBLICATION_NOT_FOUND',
  status: 404,
  title: 'Plan publication not found',
  detail: 'The requested plan publication was not found.',
})

export const ACTIVE_PLAN_MONTH_NOT_FOUND_PROBLEM = defineProblemDefinition({
  slug: 'active-plan-month-not-found',
  code: 'ACTIVE_PLAN_MONTH_NOT_FOUND',
  status: 404,
  title: 'Active plan month not found',
  detail: 'There is no active published plan for the current local date.',
})

export const PLAN_MONTH_NOT_FOUND_PROBLEM = defineProblemDefinition({
  slug: 'plan-month-not-found',
  code: 'PLAN_MONTH_NOT_FOUND',
  status: 404,
  title: 'Plan month not found',
  detail: 'The requested plan month was not found.',
})

export const PLAN_MONTH_REVISION_CONFLICT_PROBLEM = defineProblemDefinition({
  slug: 'plan-month-revision-conflict',
  code: 'PLAN_MONTH_REVISION_CONFLICT',
  status: 409,
  title: 'Plan month revision conflict',
  detail: 'The plan month changed before this request was applied.',
})

export const PLAN_MONTH_REOPEN_CONFLICT_PROBLEM = defineProblemDefinition({
  slug: 'plan-month-reopen-conflict',
  code: 'PLAN_MONTH_REOPEN_CONFLICT',
  status: 409,
  title: 'Plan month cannot be reopened',
  detail: 'The plan month is not currently eligible for reopening.',
})

export const PLAN_MONTH_RECLOSE_CONFLICT_PROBLEM = defineProblemDefinition({
  slug: 'plan-month-reclose-conflict',
  code: 'PLAN_MONTH_RECLOSE_CONFLICT',
  status: 409,
  title: 'Plan month cannot be reclosed',
  detail: 'The plan month is not currently eligible for explicit reclose.',
})
