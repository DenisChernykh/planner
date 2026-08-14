import { defineProblemDefinition } from '@/platform/http/errors/problem-registry'

export const TRACKING_AUTHORIZATION_DENIED_PROBLEM = defineProblemDefinition({
  slug: 'tracking-authorization-denied',
  code: 'TRACKING_AUTHORIZATION_DENIED',
  status: 403,
  title: 'Tracking authorization denied',
  detail: 'The current principal cannot access this tracking operation.',
})

export const TRACKING_QUERY_INVALID_PROBLEM = defineProblemDefinition({
  slug: 'tracking-query-invalid',
  code: 'TRACKING_QUERY_INVALID',
  status: 400,
  title: 'Tracking query invalid',
  detail: 'The requested tracking query is invalid.',
})

export const TRACKING_FACT_TARGET_NOT_FOUND_PROBLEM = defineProblemDefinition({
  slug: 'tracking-fact-target-not-found',
  code: 'TRACKING_FACT_TARGET_NOT_FOUND',
  status: 404,
  title: 'Tracking fact target not found',
  detail: 'The requested tracking fact target was not found.',
})

export const TRACKING_FACT_TARGET_UNAVAILABLE_PROBLEM = defineProblemDefinition(
  {
    slug: 'tracking-fact-target-unavailable',
    code: 'TRACKING_FACT_TARGET_UNAVAILABLE',
    status: 409,
    title: 'Tracking fact target unavailable',
    detail: 'The requested tracking fact target cannot be changed.',
  },
)

export const TRACKING_FACT_REVISION_CONFLICT_PROBLEM = defineProblemDefinition({
  slug: 'tracking-fact-revision-conflict',
  code: 'TRACKING_FACT_REVISION_CONFLICT',
  status: 409,
  title: 'Tracking fact revision conflict',
  detail: 'The tracking fact changed before this request was applied.',
})

export const TRACKING_FACT_VALUE_INVALID_PROBLEM = defineProblemDefinition({
  slug: 'tracking-fact-value-invalid',
  code: 'TRACKING_FACT_VALUE_INVALID',
  status: 422,
  title: 'Tracking fact value invalid',
  detail: 'The fact value does not match the published target.',
})

export const TRACKING_FACT_UNDO_UNAVAILABLE_PROBLEM = defineProblemDefinition({
  slug: 'tracking-fact-undo-unavailable',
  code: 'TRACKING_FACT_UNDO_UNAVAILABLE',
  status: 409,
  title: 'Tracking fact undo unavailable',
  detail: 'The requested own action can no longer be undone.',
})

export const TRACKING_FACT_CORRECTION_REQUIRED_PROBLEM =
  defineProblemDefinition({
    slug: 'tracking-fact-correction-required',
    code: 'TRACKING_FACT_CORRECTION_REQUIRED',
    status: 409,
    title: 'Tracking fact correction required',
    detail: 'The existing tracking fact must be changed through correction.',
  })

export const TRACKING_CLOSE_DAY_TARGET_NOT_FOUND_PROBLEM =
  defineProblemDefinition({
    slug: 'tracking-close-day-target-not-found',
    code: 'TRACKING_CLOSE_DAY_TARGET_NOT_FOUND',
    status: 404,
    title: 'CloseDay target not found',
    detail: 'The requested publication day was not found.',
  })

export const TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE_PROBLEM =
  defineProblemDefinition({
    slug: 'tracking-close-day-target-unavailable',
    code: 'TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE',
    status: 409,
    title: 'CloseDay target unavailable',
    detail: 'The requested publication day cannot be closed.',
  })

export const TRACKING_CLOSE_DAY_REVISION_CONFLICT_PROBLEM =
  defineProblemDefinition({
    slug: 'tracking-close-day-revision-conflict',
    code: 'TRACKING_CLOSE_DAY_REVISION_CONFLICT',
    status: 409,
    title: 'CloseDay revision conflict',
    detail: 'Tracking facts changed after the CloseDay preview was built.',
  })

export const TRACKING_CLOSE_DAY_PREVIEW_CONFLICT_PROBLEM =
  defineProblemDefinition({
    slug: 'tracking-close-day-preview-conflict',
    code: 'TRACKING_CLOSE_DAY_PREVIEW_CONFLICT',
    status: 409,
    title: 'CloseDay preview conflict',
    detail: 'The CloseDay preview no longer matches unresolved expectations.',
  })

export const TRACKING_CLOSE_DAY_ALREADY_CLOSED_PROBLEM =
  defineProblemDefinition({
    slug: 'tracking-close-day-already-closed',
    code: 'TRACKING_CLOSE_DAY_ALREADY_CLOSED',
    status: 409,
    title: 'Day already closed',
    detail: 'This member already closed the requested publication day.',
  })

export const TRACKING_WEEKLY_TASK_TARGET_NOT_FOUND_PROBLEM =
  defineProblemDefinition({
    slug: 'tracking-weekly-task-target-not-found',
    code: 'TRACKING_WEEKLY_TASK_TARGET_NOT_FOUND',
    status: 404,
    title: 'Weekly task target not found',
    detail: 'The requested weekly planned task was not found.',
  })

export const TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE_PROBLEM =
  defineProblemDefinition({
    slug: 'tracking-weekly-task-target-unavailable',
    code: 'TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE',
    status: 409,
    title: 'Weekly task target unavailable',
    detail: 'The requested weekly planned task cannot accept a result.',
  })

export const TRACKING_WEEKLY_TASK_ALREADY_SYSTEM_CLOSED_PROBLEM =
  defineProblemDefinition({
    slug: 'tracking-weekly-task-already-system-closed',
    code: 'TRACKING_WEEKLY_TASK_ALREADY_SYSTEM_CLOSED',
    status: 409,
    title: 'Weekly task already system closed',
    detail: 'The weekly planned task already has a system result.',
  })
